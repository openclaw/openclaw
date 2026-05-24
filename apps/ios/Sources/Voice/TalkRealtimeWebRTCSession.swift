import AVFAudio
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog
@preconcurrency import WebRTC

@MainActor
protocol TalkRealtimeWebRTCSessionDelegate: AnyObject {
    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didChangeStatus status: String)
    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didReceiveUserTranscript text: String)
    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didReceiveAssistantTranscript text: String)
    func realtimeSessionDidFinish(_ session: TalkRealtimeWebRTCSession)
}

@MainActor
final class TalkRealtimeWebRTCSession: NSObject {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "TalkRealtimeWebRTC")
    private static let toolName = "openclaw_agent_consult"
    private static let defaultOfferURL = "https://api.openai.com/v1/realtime/calls"
    private static let mediaStreamID = "openclaw-ios-realtime"
    private static let audioTrackID = "openclaw-ios-audio"
    private static let dataChannelLabel = "oai-events"
    private static let toolCallTimeoutSeconds = 12
    private static let toolResultTimeoutSeconds = 12
    private static let stillWorkingDelaySeconds = 6

    private let gateway: GatewayNodeSession
    private let sessionKey: String
    private weak var delegate: TalkRealtimeWebRTCSessionDelegate?

    private var factory: RTCPeerConnectionFactory?
    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var session: TalkRealtimeClientSession?
    private var toolBuffers: [String: ToolBuffer] = [:]
    private var activeToolTasks: [String: Task<Void, Never>] = [:]
    private var activeToolRunIds: [String: String] = [:]
    private var stopped = false
    private var timelineStartedAt = ProcessInfo.processInfo.systemUptime
    private var seenRealtimeEventTypes: Set<String> = []
    private var loggedFirstServerSpeech = false
    private var loggedFirstAssistantSignal = false

    private struct ToolBuffer {
        var name: String
        var callId: String
        var args: String
    }

    init(gateway: GatewayNodeSession, sessionKey: String, delegate: TalkRealtimeWebRTCSessionDelegate) {
        self.gateway = gateway
        self.sessionKey = sessionKey
        self.delegate = delegate
        super.init()
    }

    func start(model: String?, voice: String?, prefetchedSession: TalkRealtimeClientSession? = nil) async throws {
        self.timelineStartedAt = ProcessInfo.processInfo.systemUptime
        self.seenRealtimeEventTypes.removeAll()
        self.loggedFirstServerSpeech = false
        self.loggedFirstAssistantSignal = false
        self.stopped = false
        self.trace("start model=\(model ?? "default") voice=\(voice ?? "default") sessionKey=\(self.sessionKey)")
        self.delegate?.realtimeSession(self, didChangeStatus: "Connecting")
        let session: TalkRealtimeClientSession
        if let prefetchedSession {
            self.trace(
                "gateway talk.client.create skipped prefetched provider=\(prefetchedSession.provider) "
                    + "transport=\(prefetchedSession.transport) model=\(prefetchedSession.model ?? "unknown") "
                    + "voice=\(prefetchedSession.voice ?? "unknown")")
            session = prefetchedSession
        } else {
            session = try await self.createClientSession(model: model, voice: voice)
        }
        let sessionModel = session.model ?? "unknown"
        let sessionVoice = session.voice ?? "unknown"
        Self.logger.info(
            "realtime session provider=\(session.provider, privacy: .public) model=\(sessionModel, privacy: .public)")
        Self.logger.info(
            "realtime session voice=\(sessionVoice, privacy: .public) transport=\(session.transport, privacy: .public)")
        try self.checkNotStopped()
        guard session.isWebRTC else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Realtime provider returned unsupported transport \(session.transport)",
            ])
        }
        self.session = session

        self.trace("configure audio session start")
        try Self.configureAudioSession()
        self.trace("configure audio session done")
        RTCInitializeSSL()
        let factory = RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory())
        self.factory = factory

        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Failed to create WebRTC peer connection",
            ])
        }
        self.peerConnection = peer

        let audioSource = factory.audioSource(with: constraints)
        let audioTrack = factory.audioTrack(with: audioSource, trackId: Self.audioTrackID)
        peer.add(audioTrack, streamIds: [Self.mediaStreamID])

        let channelConfig = RTCDataChannelConfiguration()
        let channel = peer.dataChannel(forLabel: Self.dataChannelLabel, configuration: channelConfig)
        channel?.delegate = self
        self.dataChannel = channel

        let offer = try await createOffer(peer: peer)
        self.trace("local offer created sdpBytes=\(offer.sdp.utf8.count)")
        try self.checkNotStopped()
        try await self.setLocalDescription(offer, peer: peer)
        self.trace("local description set")
        try self.checkNotStopped()
        let answerSDP = try await exchangeOffer(offer.sdp, session: session)
        self.trace("remote answer received sdpBytes=\(answerSDP.utf8.count)")
        try self.checkNotStopped()
        let answer = RTCSessionDescription(type: .answer, sdp: answerSDP)
        try await setRemoteDescription(answer, peer: peer)
        self.trace("remote description set")
        try self.checkNotStopped()
        self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
    }

    func stop() {
        let shouldNotify = !self.stopped
        self.stopped = true
        self.cancelActiveToolCalls()
        self.toolBuffers.removeAll()
        self.dataChannel?.close()
        self.dataChannel = nil
        self.peerConnection?.close()
        self.peerConnection = nil
        self.factory = nil
        self.session = nil
        if shouldNotify {
            self.delegate?.realtimeSessionDidFinish(self)
        }
    }

    private func checkNotStopped() throws {
        if self.stopped {
            throw CancellationError()
        }
    }

    private func elapsedMs() -> Int {
        max(0, Int((ProcessInfo.processInfo.systemUptime - self.timelineStartedAt) * 1000))
    }

    private func trace(_ message: String) {
        GatewayDiagnostics.log("talk.timeline realtime +\(self.elapsedMs())ms \(message)")
        Self.logger.info("timeline +\(self.elapsedMs(), privacy: .public)ms \(message, privacy: .public)")
    }

    func cancelResponse() {
        self.sendRealtimeEvent(["type": "response.cancel"])
        self.cancelActiveToolCalls()
    }

    private func cancelActiveToolCalls() {
        let runIds = Array(Set(activeToolRunIds.values))
        for task in self.activeToolTasks.values {
            task.cancel()
        }
        self.activeToolTasks.removeAll()
        self.activeToolRunIds.removeAll()
        for runId in runIds {
            Task { [gateway, sessionKey] in
                let params = ["sessionKey": sessionKey, "runId": runId]
                guard let data = try? JSONSerialization.data(withJSONObject: params),
                      let json = String(data: data, encoding: .utf8)
                else { return }
                _ = try? await gateway.request(method: "chat.abort", paramsJSON: json, timeoutSeconds: 5)
            }
        }
    }

    private func createClientSession(model: String?, voice: String?) async throws -> TalkRealtimeClientSession {
        self.trace("gateway talk.client.create start")
        let startedAt = ProcessInfo.processInfo.systemUptime
        let params = TalkRealtimeClientCreateParams(model: model, voice: voice)
        let data = try JSONEncoder().encode(params)
        let json = String(data: data, encoding: .utf8)
        let res = try await gateway.request(method: "talk.client.create", paramsJSON: json, timeoutSeconds: 12)
        let session = try JSONDecoder().decode(TalkRealtimeClientSession.self, from: res)
        let elapsed = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000)
        self.trace(
            "gateway talk.client.create done elapsedMs=\(elapsed) "
                + "provider=\(session.provider) transport=\(session.transport) "
                + "model=\(session.model ?? "unknown") voice=\(session.voice ?? "unknown")")
        return session
    }

    private func createOffer(peer: RTCPeerConnection) async throws -> RTCSessionDescription {
        self.trace("local offer create start")
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: [
                "OfferToReceiveAudio": "true",
                "OfferToReceiveVideo": "false",
            ],
            optionalConstraints: nil)
        return try await withCheckedThrowingContinuation { continuation in
            peer.offer(for: constraints) { offer, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let offer {
                    continuation.resume(returning: offer)
                } else {
                    continuation.resume(throwing: NSError(domain: "TalkRealtimeWebRTC", code: 3, userInfo: [
                        NSLocalizedDescriptionKey: "OpenAI realtime offer creation returned no SDP",
                    ]))
                }
            }
        }
    }

    private func setLocalDescription(_ description: RTCSessionDescription, peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(description) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    private func setRemoteDescription(_ description: RTCSessionDescription, peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(description) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    private func exchangeOffer(_ sdp: String, session: TalkRealtimeClientSession) async throws -> String {
        let rawURL = session.offerUrl ?? Self.defaultOfferURL
        guard let url = URL(string: rawURL) else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "Invalid OpenAI realtime offer URL",
            ])
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(session.clientSecret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.httpBody = sdp.data(using: .utf8)
        for (key, value) in session.offerHeaders ?? [:] {
            request.setValue(value, forHTTPHeaderField: key)
        }

        self.trace("openai webrtc offer exchange start urlHost=\(url.host ?? "unknown")")
        let startedAt = ProcessInfo.processInfo.systemUptime
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "OpenAI realtime offer returned a non-HTTP response",
            ])
        }
        let elapsed = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000)
        self.trace("openai webrtc offer exchange response status=\(http.statusCode) elapsedMs=\(elapsed)")
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "TalkRealtimeWebRTC", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "OpenAI realtime offer failed: \(http.statusCode) \(body)",
            ])
        }
        guard let answer = String(data: data, encoding: .utf8),
              !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "OpenAI realtime offer returned an empty SDP answer",
            ])
        }
        return answer
    }

    private func handleRealtimeEvent(_ event: TalkRealtimeServerEvent) {
        if !self.seenRealtimeEventTypes.contains(event.type) {
            self.seenRealtimeEventTypes.insert(event.type)
            self.trace("event first type=\(event.type)")
        }
        switch event.type {
        case "conversation.input_transcript.delta",
             "conversation.item.input_audio_transcription.delta":
            if !self.loggedFirstServerSpeech {
                self.loggedFirstServerSpeech = true
                self.trace("server speech/transcript first delta")
            }
            if let text = event.delta ?? event.transcript {
                self.delegate?.realtimeSession(self, didReceiveUserTranscript: text)
            }
        case "conversation.input_transcript.done",
             "conversation.item.input_audio_transcription.completed":
            if let text = event.transcript ?? event.text {
                self.delegate?.realtimeSession(self, didReceiveUserTranscript: text)
            }
        case "conversation.output_transcript.delta",
             "response.output_text.delta",
             "response.audio_transcript.delta",
             "response.output_audio_transcript.delta":
            if !self.loggedFirstAssistantSignal {
                self.loggedFirstAssistantSignal = true
                self.trace("assistant first output signal type=\(event.type)")
            }
            if let text = event.delta ?? event.transcript ?? event.text {
                self.delegate?.realtimeSession(self, didReceiveAssistantTranscript: text)
            }
        case "conversation.output_transcript.done",
             "response.output_text.done",
             "response.audio_transcript.done",
             "response.output_audio_transcript.done":
            if let text = event.transcript ?? event.text {
                self.delegate?.realtimeSession(self, didReceiveAssistantTranscript: text)
            }
            self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
        case "response.created":
            self.trace("response created")
            self.delegate?.realtimeSession(self, didChangeStatus: "Speaking")
        case "input_audio_buffer.speech_started":
            if !self.loggedFirstServerSpeech {
                self.loggedFirstServerSpeech = true
                self.trace("server detected speech")
            }
            self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
        case "response.function_call_arguments.delta":
            self.bufferToolDelta(event)
        case "response.output_item.added":
            self.bufferToolMetadata(event)
        case "response.function_call_arguments.done",
             "response.output_item.done",
             "conversation.item.done":
            self.handleToolDone(event)
        case "error":
            self.delegate?.realtimeSession(self, didChangeStatus: "Realtime error")
        default:
            break
        }
    }

    private func toolBufferKey(for event: TalkRealtimeServerEvent) -> String? {
        event.resolvedItemId ?? event.resolvedCallId
    }

    private func bufferToolMetadata(_ event: TalkRealtimeServerEvent) {
        guard event.resolvedName == Self.toolName, let key = toolBufferKey(for: event) else { return }
        var buffer = self.toolBuffers[key] ?? ToolBuffer(name: "", callId: "", args: "")
        buffer.name = event.resolvedName ?? buffer.name
        buffer.callId = event.resolvedCallId ?? buffer.callId
        if let arguments = event.resolvedArguments, !arguments.isEmpty {
            buffer.args = arguments
        }
        self.toolBuffers[key] = buffer
    }

    private func bufferToolDelta(_ event: TalkRealtimeServerEvent) {
        guard let key = toolBufferKey(for: event) else { return }
        var buffer = self.toolBuffers[key] ?? ToolBuffer(
            name: event.resolvedName ?? "",
            callId: event.resolvedCallId ?? "",
            args: "")
        buffer.name = buffer.name.isEmpty ? (event.resolvedName ?? "") : buffer.name
        buffer.callId = buffer.callId.isEmpty ? (event.resolvedCallId ?? "") : buffer.callId
        buffer.args += event.delta ?? ""
        self.toolBuffers[key] = buffer
    }

    private func handleToolDone(_ event: TalkRealtimeServerEvent) {
        guard let key = toolBufferKey(for: event) else { return }
        let buffered = self.toolBuffers[key]
        let name = buffered?.name.isEmpty == false ? buffered?.name : event.resolvedName
        let callId = buffered?.callId.isEmpty == false ? buffered?.callId : event.resolvedCallId
        let args = buffered?.args.isEmpty == false ? buffered?.args : event.resolvedArguments
        guard name == Self.toolName, let callId, !callId.isEmpty else { return }
        guard args?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
            self.bufferToolMetadata(event)
            return
        }
        guard self.activeToolTasks[callId] == nil else { return }
        self.toolBuffers.removeValue(forKey: key)
        self.trace("tool call ready callId=\(callId) argsBytes=\((args ?? "").utf8.count)")
        self.delegate?.realtimeSession(self, didChangeStatus: "Asking OpenClaw")
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.submitToolCall(callId: callId, argsJSON: args ?? "{}")
        }
        self.activeToolTasks[callId] = task
    }

    private func submitToolCall(callId: String, argsJSON: String) async {
        self.trace("tool call submit start callId=\(callId) argsBytes=\(argsJSON.utf8.count)")
        let statusTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.stillWorkingDelaySeconds) * 1_000_000_000)
            guard let self, !Task.isCancelled, !self.stopped else { return }
            self.delegate?.realtimeSession(self, didChangeStatus: "Still asking OpenClaw")
        }
        defer {
            statusTask.cancel()
            self.activeToolTasks[callId] = nil
            self.activeToolRunIds[callId] = nil
        }
        do {
            let args = try Self.decodeJSONObject(argsJSON)
            let params: [String: Any] = [
                "sessionKey": sessionKey,
                "callId": callId,
                "name": Self.toolName,
                "args": args,
            ]
            let data = try JSONSerialization.data(withJSONObject: params)
            guard let json = String(data: data, encoding: .utf8) else {
                throw NSError(domain: "TalkRealtimeWebRTC", code: 7, userInfo: [
                    NSLocalizedDescriptionKey: "Failed to encode realtime tool call",
                ])
            }
            let stream = await gateway.subscribeServerEvents(bufferingNewest: 200)
            self.trace("tool call gateway request start callId=\(callId)")
            let requestStartedAt = ProcessInfo.processInfo.systemUptime
            let res = try await gateway.request(
                method: "talk.client.toolCall",
                paramsJSON: json,
                timeoutSeconds: Self.toolCallTimeoutSeconds)
            let response = try JSONDecoder().decode(TalkRealtimeToolCallResponse.self, from: res)
            let requestElapsed = Int((ProcessInfo.processInfo.systemUptime - requestStartedAt) * 1000)
            guard let runId = response.runId ?? response.idempotencyKey else {
                throw NSError(domain: "TalkRealtimeWebRTC", code: 8, userInfo: [
                    NSLocalizedDescriptionKey: "Gateway did not return a realtime tool run id",
                ])
            }
            self.trace("tool call gateway request done callId=\(callId) runId=\(runId) elapsedMs=\(requestElapsed)")
            self.activeToolRunIds[callId] = runId
            if Task.isCancelled || self.stopped {
                await self.abortChatRun(runId: runId)
                return
            }
            let result = try await waitForChatResult(
                runId: runId,
                stream: stream,
                timeoutSeconds: Self.toolResultTimeoutSeconds)
            if Task.isCancelled || self.stopped { return }
            self.trace("tool call chat result ready callId=\(callId) runId=\(runId) chars=\(result.count)")
            self.submitToolResult(callId: callId, result: ["result": result])
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled || self.stopped { return }
            Self.logger.error("realtime tool call failed: \(error.localizedDescription, privacy: .public)")
            self.trace("tool call failed callId=\(callId) error=\(error.localizedDescription)")
            if let runId = activeToolRunIds[callId] {
                await self.abortChatRun(runId: runId)
            }
            self.delegate?.realtimeSession(self, didChangeStatus: "OpenClaw unavailable")
            let fallbackMessage = [
                "OpenClaw consult did not finish quickly enough.",
                "Give a brief spoken fallback from the realtime conversation",
                "and ask the user to try again if they need OpenClaw-specific context.",
            ].joined(separator: " ")
            self.submitToolResult(callId: callId, result: [
                "error": fallbackMessage,
            ])
        }
        guard !Task.isCancelled, !self.stopped else { return }
        self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
    }

    private func abortChatRun(runId: String) async {
        let params = ["sessionKey": sessionKey, "runId": runId]
        guard let data = try? JSONSerialization.data(withJSONObject: params),
              let json = String(data: data, encoding: .utf8)
        else { return }
        _ = try? await self.gateway.request(method: "chat.abort", paramsJSON: json, timeoutSeconds: 5)
    }

    private static func decodeJSONObject(_ json: String) throws -> Any {
        let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [:] }
        let data = Data(trimmed.utf8)
        return try JSONSerialization.jsonObject(with: data)
    }

    private func waitForChatResult(
        runId: String,
        stream: AsyncStream<EventFrame>,
        timeoutSeconds: Int = 120) async throws -> String
    {
        try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask { [runId] in
                for await evt in stream {
                    guard evt.event == "chat", let payload = evt.payload else { continue }
                    guard let chatEvent = try? GatewayPayloadDecoding.decode(
                        payload,
                        as: OpenClawChatEventPayload.self)
                    else {
                        continue
                    }
                    guard chatEvent.runId == runId else { continue }
                    await MainActor.run {
                        self.trace("chat event runId=\(runId) state=\(chatEvent.state ?? "unknown")")
                    }
                    if chatEvent.state == "final" {
                        return OpenClawChatEventText.assistantText(from: chatEvent) ?? "OpenClaw finished with no text."
                    }
                    if chatEvent.state == "aborted" {
                        throw NSError(domain: "TalkRealtimeWebRTC", code: 9, userInfo: [
                            NSLocalizedDescriptionKey: "OpenClaw realtime tool call aborted",
                        ])
                    }
                    if chatEvent.state == "error" {
                        throw NSError(domain: "TalkRealtimeWebRTC", code: 10, userInfo: [
                            NSLocalizedDescriptionKey: "OpenClaw realtime tool call failed",
                        ])
                    }
                }
                throw NSError(domain: "TalkRealtimeWebRTC", code: 11, userInfo: [
                    NSLocalizedDescriptionKey: "OpenClaw realtime tool event stream ended",
                ])
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                throw NSError(domain: "TalkRealtimeWebRTC", code: 12, userInfo: [
                    NSLocalizedDescriptionKey: "OpenClaw realtime tool call timed out",
                ])
            }
            guard let result = try await group.next() else {
                throw NSError(domain: "TalkRealtimeWebRTC", code: 13, userInfo: [
                    NSLocalizedDescriptionKey: "OpenClaw realtime tool call did not finish",
                ])
            }
            group.cancelAll()
            return result
        }
    }

    private func submitToolResult(callId: String, result: [String: String]) {
        guard let output = Self.encodeJSONString(result) else { return }
        self.trace("tool result send callId=\(callId) outputBytes=\(output.utf8.count)")
        self.sendRealtimeEvent([
            "type": "conversation.item.create",
            "item": [
                "type": "function_call_output",
                "call_id": callId,
                "output": output,
            ],
        ])
        self.sendRealtimeEvent(["type": "response.create"])
    }

    private static func encodeJSONString(_ value: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(value) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func sendRealtimeEvent(_ event: [String: Any]) {
        guard
            let channel = dataChannel,
            channel.readyState == .open,
            let json = Self.encodeJSONString(event),
            let data = json.data(using: .utf8)
        else { return }
        channel.sendData(RTCDataBuffer(data: data, isBinary: false))
        if let type = event["type"] as? String {
            self.trace("client event sent type=\(type)")
        }
    }

    private static func configureAudioSession() throws {
        let config = RTCAudioSessionConfiguration.webRTC()
        config.category = AVAudioSession.Category.playAndRecord.rawValue
        config.mode = AVAudioSession.Mode.default.rawValue
        config.categoryOptions = [
            .allowBluetoothHFP,
            .defaultToSpeaker,
        ]
        config.sampleRate = 48000
        config.ioBufferDuration = 0.01
        RTCAudioSessionConfiguration.setWebRTC(config)

        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }

        session.ignoresPreferredAttributeConfigurationErrors = true
        try session.setConfiguration(config, active: true)
        try? session.overrideOutputAudioPort(.speaker)
    }
}

extension TalkRealtimeWebRTCSession: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_: RTCPeerConnection, didChange _: RTCSignalingState) {}
    nonisolated func peerConnection(_: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        Task { @MainActor in
            self
                .trace(
                    "remote stream added audioTracks=\(stream.audioTracks.count) "
                        + "videoTracks=\(stream.videoTracks.count)")
        }
    }

    nonisolated func peerConnection(_: RTCPeerConnection, didRemove _: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_: RTCPeerConnection) {}
    nonisolated func peerConnection(_: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        Task { @MainActor in
            guard !self.stopped else { return }
            switch newState {
            case .connected, .completed:
                self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
            case .disconnected:
                self.delegate?.realtimeSession(self, didChangeStatus: "Reconnecting")
            case .failed, .closed:
                self.delegate?.realtimeSession(self, didChangeStatus: "Realtime disconnected")
                self.stop()
            default:
                break
            }
        }
    }

    nonisolated func peerConnection(_: RTCPeerConnection, didChange _: RTCIceGatheringState) {}
    nonisolated func peerConnection(_: RTCPeerConnection, didGenerate _: RTCIceCandidate) {}
    nonisolated func peerConnection(_: RTCPeerConnection, didRemove _: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        Task { @MainActor in
            self.dataChannel = dataChannel
            dataChannel.delegate = self
        }
    }
}

extension TalkRealtimeWebRTCSession: RTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        Task { @MainActor in
            guard !self.stopped else { return }
            if dataChannel.readyState == .open {
                self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
            }
        }
    }

    nonisolated func dataChannel(_: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary else { return }
        let data = buffer.data
        Task { @MainActor in
            guard !self.stopped else { return }
            do {
                let event = try JSONDecoder().decode(TalkRealtimeServerEvent.self, from: data)
                self.handleRealtimeEvent(event)
            } catch {
                Self.logger
                    .debug("ignored realtime event decode failure: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
