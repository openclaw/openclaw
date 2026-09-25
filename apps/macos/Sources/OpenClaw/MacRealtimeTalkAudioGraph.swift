import AVFoundation
import OpenClawKit

/// The session owns ordinary CoreAudio I/O. Software AEC receives the rendered
/// mixer reference without VoiceProcessingIO substituting another output device.
@MainActor
final class MacRealtimeTalkAudioGraph {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let inputProcessingMode: MacRealtimeTalkInputProcessingMode
    private var playbackFormat: AVAudioFormat?
    var echoPipeline: MacRealtimeTalkEchoPipeline?
    var renderTapInstalled = false

    var input: AVAudioInputNode {
        self.engine.inputNode
    }

    var hasEchoControl: Bool {
        self.inputProcessingMode == .echoControlled && self.engine.isRunning && self.echoPipeline?.isHealthy == true
    }

    init(sampleRate: Double, inputProcessingMode: MacRealtimeTalkInputProcessingMode = .echoControlled) throws {
        self.inputProcessingMode = inputProcessingMode
        // Materialize duplex I/O before connecting the mixer. Output-only
        // startup otherwise queues a configuration change when input creates
        // its aggregate, which can arrive after capture has already started.
        _ = self.engine.inputNode
        let output = self.engine.outputNode
        let hardwareFormat = output.outputFormat(forBus: 0)
        let connectionFormat = output.inputFormat(forBus: 0)
        // Unavailable output can raise an Objective-C exception during graph connection.
        guard hardwareFormat.sampleRate.isFinite, hardwareFormat.sampleRate > 0, hardwareFormat.channelCount > 0,
              connectionFormat.sampleRate.isFinite, connectionFormat.sampleRate > 0, connectionFormat.channelCount > 0
        else { throw MacRealtimeTalkAudioCaptureError.outputUnavailable }
        self.engine.attach(self.player)
        try self.connectPlayback(sampleRate: sampleRate)
        self.engine.connect(self.engine.mainMixerNode, to: output, format: connectionFormat)
    }

    func connectPlayback(sampleRate: Double) throws {
        guard sampleRate.isFinite, sampleRate > 0,
              let format = AVAudioFormat(
                  commonFormat: .pcmFormatInt16,
                  sampleRate: sampleRate,
                  channels: 1,
                  interleaved: false)
        else { throw MacRealtimeTalkAudioCaptureError.invalidTargetSampleRate }
        self.engine.connect(self.player, to: self.engine.mainMixerNode, format: format)
        self.playbackFormat = format
    }

    func preparePlayback(sampleRate: Double) throws {
        guard self.engine.isRunning else { throw MacRealtimeTalkAudioCaptureError.inputUnavailable }
        self.player.stop()
        if self.playbackFormat?.sampleRate != sampleRate {
            // Only this stopped source node changes format; the shared I/O
            // formats and the microphone tap remain at their hardware rate.
            try self.connectPlayback(sampleRate: sampleRate)
        }
        self.player.play()
    }

    func schedule(
        _ data: Data,
        callbackType: AVAudioPlayerNodeCompletionCallbackType = .dataConsumed,
        completion: @escaping RealtimePCMStreamingAudioPlayer.Completion) throws
    {
        guard self.engine.isRunning, let format = self.playbackFormat,
              data.count.isMultiple(of: MemoryLayout<Int16>.size),
              let buffer = AVAudioPCMBuffer(
                  pcmFormat: format,
                  frameCapacity: AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)),
              let channel = buffer.int16ChannelData?[0]
        else { throw MacRealtimeTalkAudioCaptureError.invalidInputFormat }
        buffer.frameLength = buffer.frameCapacity
        data.copyBytes(to: UnsafeMutableRawBufferPointer(start: channel, count: data.count))
        self.player.scheduleBuffer(buffer, completionCallbackType: callbackType) { _ in completion() }
    }

    var playbackTime: Double? {
        guard let renderTime = self.player.lastRenderTime,
              let playerTime = self.player.playerTime(forNodeTime: renderTime)
        else { return nil }
        return Double(playerTime.sampleTime) / playerTime.sampleRate
    }

    func stop() {
        self.echoPipeline?.stop()
        if self.renderTapInstalled {
            self.engine.mainMixerNode.removeTap(onBus: 0)
            self.renderTapInstalled = false
        }
        self.echoPipeline = nil
        self.player.stop()
        self.engine.stop()
    }
}
