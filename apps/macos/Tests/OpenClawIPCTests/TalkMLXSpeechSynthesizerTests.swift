import Darwin
import Foundation
import OpenClawMLXTTSProtocol
import Testing
@testable import OpenClaw

#if arch(arm64)
@Suite(.serialized)
struct TalkMLXSpeechSynthesizerTests {
    @Test @MainActor
    func `shutdown reaps a TERM-resistant helper before returning`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-mlx-tts-lifecycle-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let helper = directory.appendingPathComponent("openclaw-mlx-tts-test-helper")
        let pidFile = directory.appendingPathComponent("helper.pid")
        let readyFrame = directory.appendingPathComponent("ready.frame")
        defer { TestProcessSupport.killLeakedProcesses(in: [pidFile]) }
        try MLXTTSFrameCodec.encode(MLXTTSEvent.ready).write(to: readyFrame)
        try Data("""
        #!/bin/sh
        trap '' TERM
        printf '%s\\n' "$$" > "$OPENCLAW_MLX_TTS_PID_FILE"
        /bin/cat "$OPENCLAW_MLX_TTS_READY_FILE"
        exec /bin/sleep 30
        """.utf8).write(to: helper)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helper.path)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_MLX_TTS_BIN": helper.path,
            "OPENCLAW_MLX_TTS_PID_FILE": pidFile.path,
            "OPENCLAW_MLX_TTS_READY_FILE": readyFrame.path,
        ]) {
            let synthesizer = TalkMLXSpeechSynthesizer.shared
            await synthesizer.shutdown()
            let synthesis = Task {
                try await self.collectSynthesis(
                    synthesizer,
                    text: "hold transport open",
                    modelRepo: nil,
                    language: nil,
                    voicePreset: nil)
            }
            let pid = try await TestProcessSupport.waitForPID(in: pidFile)

            await synthesizer.shutdown()
            let helperWasReaped = await TestProcessSupport.waitUntilGone(
                pid,
                timeout: .milliseconds(100))
            if !helperWasReaped {
                _ = kill(pid, SIGKILL)
            }
            synthesis.cancel()
            _ = try? await synthesis.value

            #expect(await TestProcessSupport.waitUntilGone(pid))
            #expect(helperWasReaped)
        }
    }

    @Test
    func `stale startup exit cannot discard the replacement helper`() async throws {
        let stale = TestMLXTransport(mode: .staleStartupClose)
        let replacement = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([stale, replacement])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let staleSynthesis = Task {
            try await self.collectSynthesis(
                synthesizer,
                text: "stale startup",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await factory.waitForCall()
        await synthesizer.shutdown()

        _ = try await self.collectSynthesis(
            synthesizer,
            text: "replacement",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)
        await stale.finishStaleClose()
        _ = try? await staleSynthesis.value
        _ = try await self.collectSynthesis(
            synthesizer,
            text: "reuse replacement",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)

        #expect(await factory.callCount == 2)
        await synthesizer.shutdown()
    }

    @Test
    func `stale startup ready cannot discard the replacement helper`() async throws {
        let stale = TestMLXTransport(mode: .staleStartupReady)
        let replacement = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([stale, replacement])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let staleSynthesis = Task {
            try await self.collectSynthesis(
                synthesizer,
                text: "stale startup",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await factory.waitForCall()
        await synthesizer.shutdown()

        _ = try await self.collectSynthesis(
            synthesizer,
            text: "replacement",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)
        await stale.finishStaleReady()
        _ = try? await staleSynthesis.value
        _ = try await self.collectSynthesis(
            synthesizer,
            text: "reuse replacement",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)

        #expect(await factory.callCount == 2)
        await synthesizer.shutdown()
    }

    @Test
    func `stale stream timeout cannot discard the replacement helper`() async throws {
        let stale = TestMLXTransport(mode: .staleStreamTimeout)
        let replacement = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([stale, replacement])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let playback = try await synthesizer.synthesizeStream(
            text: "stale stream",
            modelRepo: nil,
            language: nil,
            voicePreset: nil,
            referenceAudioPath: nil,
            referenceText: nil,
            stallTimeoutSeconds: 0.25)
        let staleConsumption = Task {
            for try await _ in playback.chunks {}
        }
        await stale.waitForBlockedEvent()
        await synthesizer.shutdown()

        _ = try await self.collectSynthesis(
            synthesizer,
            text: "replacement",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)
        _ = try? await staleConsumption.value
        _ = try await self.collectSynthesis(
            synthesizer,
            text: "reuse replacement",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)

        #expect(await factory.callCount == 2)
        await synthesizer.shutdown()
    }

    @Test(arguments: [false, true])
    func `stale stream audio cannot survive shutdown or discard replacement`(_ legacyFrame: Bool) async throws {
        let stale = TestMLXTransport(mode: legacyFrame ? .staleStreamLateAudio : .staleStreamLateChunk)
        let replacement = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([stale, replacement])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let staleSynthesis = Task {
            try await self.collectSynthesis(
                synthesizer,
                text: "stale stream",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await stale.waitForPendingEventRead()
        await synthesizer.shutdown()
        _ = try await self.collectSynthesis(
            synthesizer,
            text: "replacement",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)
        await stale.deliverLateOutput()
        do {
            _ = try await staleSynthesis.value
            Issue.record("expected stale stream cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await stale.closeCount == 1)
        }
        _ = try await self.collectSynthesis(
            synthesizer,
            text: "reuse replacement",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)
        #expect(await factory.callCount == 2)
        await synthesizer.shutdown()
    }

    @Test
    func `reuses resident helper across utterances`() async throws {
        let transport = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let first = try await self.collectSynthesis(
            synthesizer,
            text: "first",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)
        let second = try await self.collectSynthesis(
            synthesizer,
            text: "second",
            modelRepo: "repo-a",
            language: "en",
            voicePreset: "voice-a")

        #expect(first.sampleRate == 32000)
        #expect(first.pcm == Data([0x00, 0x00, 0xFF, 0x7F]))
        #expect(second.sampleRate == 32000)
        #expect(second.pcm == Data([0x00, 0x00, 0xFF, 0x7F]))
        #expect(await factory.callCount == 1)
        let requests = await transport.sent
        #expect(requests.count == 2)
        guard case let .synthesize(firstRequest) = requests[0],
              case let .synthesize(secondRequest) = requests[1]
        else {
            Issue.record("expected two synthesis requests")
            return
        }
        #expect(firstRequest.modelRepo == TalkMLXSpeechSynthesizer.defaultModelRepo)
        #expect(secondRequest.modelRepo == "repo-a")
        #expect(secondRequest.language == "en")
        #expect(secondRequest.voice == "voice-a")
    }

    @Test
    func `streams pcm and forwards Fish reference inputs`() async throws {
        let transport = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let playback = try await synthesizer.synthesizeStream(
            text: "[whisper] keep this quiet",
            modelRepo: "mlx-community/fish-audio-s2-pro-8bit",
            language: nil,
            voicePreset: nil,
            referenceAudioPath: "/tmp/reference.wav",
            referenceText: "reference transcript")
        var received = Data()
        for try await chunk in playback.chunks {
            received.append(chunk)
        }

        #expect(playback.sampleRate == 32000)
        #expect(received == Data([0x00, 0x00, 0xFF, 0x7F]))
        let requests = await transport.sent
        guard let firstRequest = requests.first,
              case let .synthesize(request) = firstRequest
        else {
            Issue.record("expected synthesis request")
            return
        }
        #expect(request.stream)
        #expect(request.referenceAudioPath == "/tmp/reference.wav")
        #expect(request.referenceText == "reference transcript")
        #expect(request.text == "[whisper] keep this quiet")
    }

    @Test
    func `ending stream consumption cancels the helper request`() async throws {
        let transport = TestMLXTransport(mode: .streamWaitForCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        var playback: MLXTTSPlaybackStream? = try await synthesizer.synthesizeStream(
            text: "stop streaming",
            modelRepo: nil,
            language: nil,
            voicePreset: nil,
            referenceAudioPath: nil,
            referenceText: nil)
        #expect(playback?.sampleRate == 32000)
        playback = nil
        await transport.waitForCancelRequest()

        #expect(await transport.closeCount == 0)
    }

    @Test
    func `stream stall terminates the helper`() async throws {
        let transport = TestMLXTransport(mode: .streamWaitForCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let playback = try await synthesizer.synthesizeStream(
            text: "stall after first chunk boundary",
            modelRepo: nil,
            language: nil,
            voicePreset: nil,
            referenceAudioPath: nil,
            referenceText: nil,
            stallTimeoutSeconds: 0.01)

        do {
            for try await _ in playback.chunks {}
            Issue.record("expected stream timeout")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.timedOut {
            #expect(await transport.closeCount == 1)
        }
    }

    @Test
    func `retries once after helper crash`() async throws {
        let crashed = TestMLXTransport(mode: .crash)
        let restarted = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([crashed, restarted])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let data = try await self.collectSynthesis(
            synthesizer,
            text: "retry me",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)

        #expect(data.sampleRate == 32000)
        #expect(data.pcm == Data([0x00, 0x00, 0xFF, 0x7F]))
        #expect(await factory.callCount == 2)
        #expect(await crashed.closeCount == 1)
        #expect(await restarted.sent.count == 1)
    }

    @Test
    func `cancel uses protocol without closing helper`() async throws {
        let transport = TestMLXTransport(mode: .waitForCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let synthesis = Task {
            try await self.collectSynthesis(
                synthesizer,
                text: "cancel me",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await transport.waitForSynthesisRequest()
        await synthesizer.cancelCurrent()

        do {
            _ = try await synthesis.value
            Issue.record("expected cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount == 0)
            #expect(await transport.sent.contains { request in
                if case .cancel = request {
                    return true
                }
                return false
            })
        }
    }

    @Test(arguments: [false, true])
    func `late audio after cancel is discarded`(_ afterStreamStart: Bool) async throws {
        let transport = TestMLXTransport(mode: afterStreamStart ? .streamAudioAfterCancel : .audioAfterCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let synthesis = Task {
            try await self.collectSynthesis(
                synthesizer,
                text: "discard me",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await transport.waitForSynthesisRequest()
        if afterStreamStart {
            await transport.waitForPendingEventRead()
        }
        await synthesizer.cancelCurrent()

        do {
            _ = try await synthesis.value
            Issue.record("expected cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount == 0)
        }
    }

    @Test
    func `unresponsive cancel terminates helper without retry`() async throws {
        let transport = TestMLXTransport(mode: .ignoreCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60),
            cancelGraceDuration: .milliseconds(10))

        let synthesis = Task {
            try await self.collectSynthesis(
                synthesizer,
                text: "cancel me hard",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await transport.waitForSynthesisRequest()
        await synthesizer.cancelCurrent()

        do {
            _ = try await synthesis.value
            Issue.record("expected cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount == 1)
            #expect(await factory.callCount == 1)
        }
    }

    @Test
    func `shutdown terminates unresponsive in-flight helper`() async throws {
        let transport = TestMLXTransport(mode: .ignoreCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let synthesis = Task {
            try await self.collectSynthesis(
                synthesizer,
                text: "stop during shutdown",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await transport.waitForSynthesisRequest()
        await synthesizer.shutdown()

        do {
            _ = try await synthesis.value
            Issue.record("expected cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount == 1)
            #expect(await transport.sent.contains(.shutdown))
        }
    }

    @Test
    func `memory pressure during synthesis preserves fallback`() async throws {
        let transport = TestMLXTransport(mode: .ignoreCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let synthesis = Task {
            try await self.collectSynthesis(
                synthesizer,
                text: "fall back after pressure",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await transport.waitForSynthesisRequest()
        await synthesizer.handleMemoryPressure()

        do {
            _ = try await synthesis.value
            Issue.record("expected generation failure")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.audioGenerationFailed {
            #expect(await transport.closeCount == 1)
            #expect(await transport.sent.contains(.shutdown))
        }
    }

    @Test
    func `cancel can terminate helper before ready`() async throws {
        let transport = TestMLXTransport(mode: .startupHang)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60),
            cancelGraceDuration: .milliseconds(10))

        let synthesis = Task {
            try await self.collectSynthesis(
                synthesizer,
                text: "never ready",
                modelRepo: nil,
                language: nil,
                voicePreset: nil)
        }
        await factory.waitForCall()
        await synthesizer.cancelCurrent()

        do {
            _ = try await synthesis.value
            Issue.record("expected cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount >= 1)
            #expect(await factory.callCount == 1)
        }
    }

    @Test
    func `idle timeout shuts down resident helper`() async throws {
        let transport = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .milliseconds(10))

        _ = try await self.collectSynthesis(
            synthesizer,
            text: "brief",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)
        await transport.waitForShutdown()

        #expect(await transport.closeCount == 1)
    }

    @Test
    func `legacy audio response is delivered as PCM`() async throws {
        let transport = TestMLXTransport(mode: .audio)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let audio = try await self.collectSynthesis(
            synthesizer,
            text: "legacy helper",
            modelRepo: nil,
            language: nil,
            voicePreset: nil)

        #expect(audio.sampleRate == 32000)
        #expect(audio.pcm == Data([0x00, 0x00, 0xFF, 0x7F]))
        await synthesizer.shutdown()
    }

    private func collectSynthesis(
        _ synthesizer: TalkMLXSpeechSynthesizer,
        text: String,
        modelRepo: String?,
        language: String?,
        voicePreset: String?) async throws -> (sampleRate: Double, pcm: Data)
    {
        let playback = try await synthesizer.synthesizeStream(
            text: text,
            modelRepo: modelRepo,
            language: language,
            voicePreset: voicePreset,
            referenceAudioPath: nil,
            referenceText: nil)
        var pcm = Data()
        for try await chunk in playback.chunks {
            pcm.append(chunk)
        }
        return (playback.sampleRate, pcm)
    }
}

private enum TestMLXTransportError: Error {
    case closed
}

private actor TestMLXTransport: MLXTTSTransport {
    enum Mode: Equatable, Sendable {
        case audio
        case audioAfterCancel
        case crash
        case ignoreCancel
        case staleStartupClose
        case staleStartupReady
        case staleStreamTimeout
        case staleStreamLateAudio
        case staleStreamLateChunk
        case streamAudioAfterCancel
        case startupHang
        case stream
        case streamWaitForCancel
        case waitForCancel
    }

    let mode: Mode
    private(set) var sent: [MLXTTSRequest] = []
    private(set) var closeCount = 0
    private var events: [MLXTTSEvent] = [.ready]
    private var closed = false
    private var pendingEventRead = false

    init(mode: Mode) {
        self.mode = mode
        if mode == .startupHang || mode == .staleStartupClose || mode == .staleStartupReady {
            self.events = []
        }
    }

    func send(_ request: MLXTTSRequest) {
        self.sent.append(request)
        switch request {
        case let .synthesize(synthesize):
            switch self.mode {
            case .audio:
                self.events.append(.audio(MLXTTSAudio(
                    id: synthesize.id,
                    sampleRate: 32000,
                    pcm: Data([0x00, 0x00, 0xFF, 0x7F]))))
            case .stream:
                self.events.append(.streamStarted(MLXTTSStreamStart(
                    id: synthesize.id,
                    sampleRate: 32000)))
                self.events.append(.audioChunk(MLXTTSAudioChunk(
                    id: synthesize.id,
                    pcm: Data([0x00, 0x00, 0xFF, 0x7F]))))
                self.events.append(.completed(id: synthesize.id))
            case .staleStreamTimeout, .streamWaitForCancel, .streamAudioAfterCancel,
                 .staleStreamLateAudio, .staleStreamLateChunk:
                self.events.append(.streamStarted(MLXTTSStreamStart(
                    id: synthesize.id,
                    sampleRate: 32000)))
            case .crash:
                self.closed = true
            case .audioAfterCancel, .ignoreCancel, .staleStartupClose, .staleStartupReady,
                 .startupHang, .waitForCancel:
                break
            }
        case let .cancel(id):
            if self.mode == .audioAfterCancel || self.mode == .streamAudioAfterCancel {
                self.events.append(.audio(MLXTTSAudio(
                    id: id,
                    sampleRate: 32000,
                    pcm: Data([0x00, 0x00, 0xFF, 0x7F]))))
            } else if self.mode != .ignoreCancel,
                      self.mode != .staleStartupReady,
                      self.mode != .staleStreamTimeout,
                      self.mode != .staleStreamLateAudio,
                      self.mode != .staleStreamLateChunk,
                      self.mode != .startupHang
            {
                self.events.append(.canceled(id: id))
            }
        case .shutdown:
            if self.mode != .staleStartupClose,
               self.mode != .staleStartupReady,
               self.mode != .staleStreamTimeout,
               self.mode != .staleStreamLateAudio,
               self.mode != .staleStreamLateChunk
            {
                self.closed = true
            }
        }
    }

    func nextEvent() async throws -> MLXTTSEvent {
        if self.events.isEmpty {
            self.pendingEventRead = true
        }
        while self.events.isEmpty {
            if self.closed {
                throw TestMLXTransportError.closed
            }
            await Task.yield()
        }
        return self.events.removeFirst()
    }

    func close() {
        self.closeCount += 1
        if self.mode != .staleStartupClose,
           self.mode != .staleStartupReady,
           self.mode != .staleStreamTimeout,
           self.mode != .staleStreamLateAudio,
           self.mode != .staleStreamLateChunk
        {
            self.closed = true
        }
    }

    func finishStaleClose() {
        self.closed = true
    }

    func finishStaleReady() {
        self.events.append(.ready)
    }

    func waitForPendingEventRead() async {
        while !self.pendingEventRead {
            await Task.yield()
        }
    }

    func deliverLateOutput() {
        guard let request = self.sent.first, case let .synthesize(synthesize) = request else {
            Issue.record("expected a synthesis request before late output")
            return
        }
        let pcm = Data([0x00, 0x00, 0xFF, 0x7F])
        if self.mode == .staleStreamLateAudio {
            self.events.append(.audio(MLXTTSAudio(id: synthesize.id, sampleRate: 32000, pcm: pcm)))
        } else {
            self.events.append(.audioChunk(MLXTTSAudioChunk(id: synthesize.id, pcm: pcm)))
            self.events.append(.completed(id: synthesize.id))
        }
    }

    func waitForBlockedEvent() async {
        while !self.events.isEmpty {
            await Task.yield()
        }
    }

    func waitForSynthesisRequest() async {
        while !self.sent.contains(where: {
            if case .synthesize = $0 {
                return true
            }
            return false
        }) {
            await Task.yield()
        }
    }

    func waitForShutdown() async {
        while !self.sent.contains(.shutdown) || self.closeCount == 0 {
            await Task.yield()
        }
    }

    func waitForCancelRequest() async {
        while !self.sent.contains(where: {
            if case .cancel = $0 {
                return true
            }
            return false
        }) {
            await Task.yield()
        }
    }
}

private actor TestMLXTransportFactory {
    private var transports: [TestMLXTransport]
    private(set) var callCount = 0

    init(_ transports: [TestMLXTransport]) {
        self.transports = transports
    }

    func make() throws -> any MLXTTSTransport {
        self.callCount += 1
        guard !self.transports.isEmpty else {
            throw TestMLXTransportError.closed
        }
        return self.transports.removeFirst()
    }

    func waitForCall() async {
        while self.callCount == 0 {
            await Task.yield()
        }
    }
}
#endif
