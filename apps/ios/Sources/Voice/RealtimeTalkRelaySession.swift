import AVFAudio
import Foundation
import OpenClawKit

private func makeRealtimeAudioTapBlock(
    inputSampleRate: Double,
    targetSampleRate: Double,
    onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) -> AVAudioNodeTapBlock
{
    { buffer, _ in
        // Core Audio invokes this on its realtime queue; the relay owns the hop
        // back to MainActor and never exposes AVAudioBuffer across that boundary.
        let encoded = RealtimeTalkPCM16Encoder.encode(
            buffer: buffer,
            inputSampleRate: inputSampleRate,
            targetSampleRate: targetSampleRate)
        guard !encoded.isEmpty else { return }
        onAudio(RealtimeTalkAudioFrame(
            data: encoded,
            timestampMs: (ProcessInfo.processInfo.systemUptime * 1000).rounded(),
            rms: Float(TalkAudioLevel.rms(buffer: buffer))))
    }
}

@MainActor
final class IOSRealtimeTalkAudioCapture: RealtimeTalkAudioCapturing {
    private static let bufferSize: AVAudioFrameCount = 2048
    /// With voice processing the reply player renders on this engine too: echo cancellation only
    /// removes output from its own I/O unit, so a separate playback engine would leave it uncancelled.
    let audioEngine = AVAudioEngine()
    private let voiceProcessing: Bool
    private var tappedInputNode: AVAudioInputNode?
    private var voiceProcessingActive = false
    private var configurationObserver: NSObjectProtocol?
    private var onFailure: (@MainActor (String) -> Void)?
    /// Restarting the engine stops attached nodes; the owner of the reply player resumes it.
    var onEngineRestarted: (@MainActor () -> Void)?

    init(voiceProcessing: Bool) {
        self.voiceProcessing = voiceProcessing
    }

    var suppressesInputDuringOutput: Bool {
        // With echo cancellation the built-in speaker can stay full duplex. Without it, speaker
        // output bleeds into the mic even in voiceChat mode; headsets retain full-duplex barge-in.
        guard !self.voiceProcessingActive else { return false }
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        return outputs.contains { $0.portType == .builtInSpeaker }
    }

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws
    {
        self.stop()
        let input = self.audioEngine.inputNode
        // Must precede engine start; failure keeps the half-duplex speaker behavior.
        self.voiceProcessingActive = false
        if self.voiceProcessing {
            do {
                try input.setVoiceProcessingEnabled(true)
                self.voiceProcessingActive = true
            } catch {
                GatewayDiagnostics.log(
                    "talk realtime audio: voice processing unavailable: \(error.localizedDescription)")
            }
        }
        // Voice processing changes the input node's output format; tap what it delivers.
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "RealtimeTalkRelay", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "Invalid realtime audio input format",
            ])
        }
        input.installTap(
            onBus: 0,
            bufferSize: Self.bufferSize,
            format: format,
            block: makeRealtimeAudioTapBlock(
                inputSampleRate: format.sampleRate,
                targetSampleRate: targetSampleRate,
                onAudio: onAudio))
        self.tappedInputNode = input
        self.onFailure = onFailure
        // Enabling voice processing reconfigures the I/O unit shortly after start and leaves the
        // engine stopped until someone starts it again. Engines without it keep their stop.
        if self.voiceProcessingActive {
            self.configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange,
                object: self.audioEngine,
                queue: .main)
            { [weak self] _ in
                MainActor.assumeIsolated { self?.restartAfterConfigurationChange() }
            }
        }
        self.audioEngine.prepare()
        try self.audioEngine.start()
    }

    func stop() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        self.onFailure = nil
        // Reading inputNode creates RemoteIO even when capture never started.
        // Cold relay cancellation must only tear down an already installed tap.
        self.tappedInputNode?.removeTap(onBus: 0)
        self.tappedInputNode = nil
        self.audioEngine.stop()
    }

    private func restartAfterConfigurationChange() {
        guard self.tappedInputNode != nil, !self.audioEngine.isRunning else { return }
        do {
            self.audioEngine.prepare()
            try self.audioEngine.start()
            self.onEngineRestarted?()
        } catch {
            // The relay presents this inside its localized "Realtime audio failed" issue.
            self.onFailure?(error.localizedDescription)
        }
    }
}

extension RealtimeTalkRelayTransport {
    static func ios(gateway: GatewayNodeSession, route: GatewayNodeSessionRoute) -> Self {
        Self(
            subscribeServerEvents: { bufferingNewest in
                await gateway.subscribeServerEvents(bufferingNewest: bufferingNewest)
            },
            request: { method, params, timeoutMs in
                let response = try await gateway.request(
                    method: method,
                    params: params,
                    timeoutMs: timeoutMs,
                    ifCurrentRoute: route)
                guard await gateway.currentRoute() == route else { throw CancellationError() }
                return response
            },
            isCurrent: { await gateway.currentRoute() == route })
    }
}
