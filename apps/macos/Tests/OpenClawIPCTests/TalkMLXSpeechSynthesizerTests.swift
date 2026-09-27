import Darwin
import Foundation
import OpenClawKit
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
                try await self.collectSynthesis(synthesizer, text: "hold transport open")
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
            try await self.collectSynthesis(synthesizer, text: "stale startup")
        }
        await factory.waitForCall()
        await synthesizer.shutdown()

        _ = try await self.collectSynthesis(synthesizer, text: "replacement")
        await stale.finishStaleClose()
        _ = try? await staleSynthesis.value
        _ = try await self.collectSynthesis(synthesizer, text: "reuse replacement")

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
            try await self.collectSynthesis(synthesizer, text: "stale startup")
        }
        await factory.waitForCall()
        await synthesizer.shutdown()

        _ = try await self.collectSynthesis(synthesizer, text: "replacement")
        await stale.finishStaleReady()
        _ = try? await staleSynthesis.value
        _ = try await self.collectSynthesis(synthesizer, text: "reuse replacement")

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

        _ = try await self.collectSynthesis(synthesizer, text: "replacement")
        _ = try? await staleConsumption.value
        _ = try await self.collectSynthesis(synthesizer, text: "reuse replacement")

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
            try await self.collectSynthesis(synthesizer, text: "stale stream")
        }
        await stale.waitForPendingEventRead()
        await synthesizer.shutdown()
        _ = try await self.collectSynthesis(synthesizer, text: "replacement")
        await stale.deliverLateOutput()
        do {
            _ = try await staleSynthesis.value
            Issue.record("expected stale stream cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await stale.closeCount == 1)
        }
        _ = try await self.collectSynthesis(synthesizer, text: "reuse replacement")
        #expect(await factory.callCount == 2)
        await synthesizer.shutdown()
    }

    @Test
    func `stale factory completion closes only its unpublished helper`() async throws {
        let stale = TestMLXTransport(mode: .stream)
        let replacement = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([stale, replacement], holdsFirstCall: true)
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let staleSynthesis = Task {
            try await self.collectSynthesis(synthesizer, text: "unpublished helper")
        }
        await factory.waitForCall()
        await synthesizer.shutdown()
        let replacementResult = await Task {
            try await self.collectSynthesis(synthesizer, text: "replacement")
        }.result
        await factory.releaseFirstCall()
        do {
            _ = try await staleSynthesis.value
            Issue.record("expected unpublished request cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {}
        _ = try replacementResult.get()
        #expect(await stale.closeCount == 1)
        _ = try await self.collectSynthesis(synthesizer, text: "reuse replacement")
        #expect(await factory.callCount == 2)
        #expect(await stale.sent.isEmpty)
        await synthesizer.shutdown()
        #expect(await replacement.closeCount == 1)
    }

    @Test(arguments: [false, true])
    func `shutdown revokes ownership while cancel send is suspended`(_ legacyFrame: Bool) async throws {
        let stale = TestMLXTransport(
            mode: legacyFrame ? .staleStreamLateAudio : .staleStreamLateChunk,
            holdsFirstCancelSend: true)
        let replacement = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([stale, replacement])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let staleSynthesis = Task {
            try await self.collectSynthesis(synthesizer, text: "retiring stream")
        }
        await stale.waitForPendingEventRead()
        let shutdown = Task { await synthesizer.shutdown() }
        await stale.waitForCancelRequest()
        await stale.deliverLateOutput()
        let staleResult = await staleSynthesis.result
        let playbackResult = await Task {
            try await synthesizer.synthesizeStream(
                text: "replacement during shutdown",
                modelRepo: nil,
                language: nil,
                voicePreset: nil,
                referenceAudioPath: nil,
                referenceText: nil)
        }.result
        #expect(await factory.callCount == 2)
        await stale.releaseCancelSend()
        await shutdown.value
        do {
            _ = try staleResult.get()
            Issue.record("expected cancellation before shutdown sends resume")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {}
        let playback = try playbackResult.get()
        var pcm = Data()
        for try await chunk in playback.chunks {
            pcm.append(chunk)
        }
        #expect(pcm == Data([0x00, 0x00, 0xFF, 0x7F]))
        #expect(await replacement.closeCount == 0)
        _ = try await self.collectSynthesis(synthesizer, text: "reuse replacement")
        #expect(await factory.callCount == 2)
        await synthesizer.shutdown()
    }

    @Test
    func `stale cancel completion preserves replacement cancel escalation`() async throws {
        let transport = TestMLXTransport(mode: .staleStreamLateChunk, holdsFirstCancelSend: true)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let first = try await synthesizer.synthesizeStream(
            text: "first",
            modelRepo: nil,
            language: nil,
            voicePreset: nil,
            referenceAudioPath: nil,
            referenceText: nil)
        await transport.waitForPendingEventRead()
        let staleCancellation = Task { await synthesizer.cancelCurrent() }
        await transport.waitForCancelRequest()
        await transport.cancelFirstSynthesis()
        let firstResult = await Task {
            for try await _ in first.chunks {}
        }.result
        let replacementResult = await Task {
            try await synthesizer.synthesizeStream(
                text: "replacement",
                modelRepo: nil,
                language: nil,
                voicePreset: nil,
                referenceAudioPath: nil,
                referenceText: nil)
        }.result
        await synthesizer.cancelCurrent()
        await transport.releaseCancelSend()
        await staleCancellation.value
        do {
            try firstResult.get()
            Issue.record("expected first request cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {}
        let replacement = try replacementResult.get()
        do {
            try await AsyncTimeout.withTimeout(
                seconds: 4,
                onTimeout: { TestMLXTransportError.cancelGraceTimedOut },
                operation: { try await transport.waitForClose() })
        } catch {
            Issue.record("replacement cancellation grace did not close the helper: \(error)")
            await synthesizer.shutdown()
        }
        do {
            for try await _ in replacement.chunks {}
            Issue.record("expected unresponsive replacement cancellation to close the helper")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {
            #expect(await transport.closeCount == 1)
        } catch {
            Issue.record("expected a canceled terminal outcome after helper closure: \(error)")
        }
        await synthesizer.shutdown()
    }

    @Test
    func `reuses resident helper across utterances`() async throws {
        let transport = TestMLXTransport(mode: .stream)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let first = try await self.collectSynthesis(synthesizer, text: "first")
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

        let data = try await self.collectSynthesis(synthesizer, text: "retry me")

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
            try await self.collectSynthesis(synthesizer, text: "cancel me")
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
            try await self.collectSynthesis(synthesizer, text: "discard me")
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
    func `late helper failure before stream start stays canceled`() async throws {
        let transport = TestMLXTransport(mode: .errorAfterCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let synthesis = Task {
            try await self.collectSynthesis(synthesizer, text: "cancel before helper failure")
        }
        await transport.waitForSynthesisRequest()
        await synthesizer.cancelCurrent()
        do {
            _ = try await synthesis.value
            Issue.record("expected canceled helper failure")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {} catch {
            Issue.record("late helper failure returned a non-cancellation outcome: \(error)")
        }
        #expect(await factory.callCount == 1)
        await synthesizer.shutdown()
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
            try await self.collectSynthesis(synthesizer, text: "cancel me hard")
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

    @Test(arguments: [false, true])
    func `stopping an unresponsive active stream stays canceled`(_ shutdown: Bool) async throws {
        let transport = TestMLXTransport(mode: .streamIgnoreCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60),
            cancelGraceDuration: .milliseconds(10))
        let synthesis = Task {
            try await self.collectSynthesis(synthesizer, text: "user-stopped stream")
        }
        await transport.waitForPendingEventRead()
        if shutdown {
            await synthesizer.shutdown()
        } else {
            await synthesizer.cancelCurrent()
        }
        do {
            _ = try await synthesis.value
            Issue.record("expected stopped stream cancellation")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.canceled {} catch {
            Issue.record("stopped stream returned a non-cancellation outcome: \(error)")
        }
        #expect(await transport.closeCount == 1)
        #expect(await factory.callCount == 1)
        await synthesizer.shutdown()
    }

    @Test
    func `shutdown terminates unresponsive in-flight helper`() async throws {
        let transport = TestMLXTransport(mode: .ignoreCancel)
        let factory = TestMLXTransportFactory([transport])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))

        let synthesis = Task {
            try await self.collectSynthesis(synthesizer, text: "stop during shutdown")
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
            try await self.collectSynthesis(synthesizer, text: "fall back after pressure")
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

    @Test(arguments: [false, true])
    func `repeated memory pressure preserves every pending fallback`(_ pressureOnReplacement: Bool) async throws {
        let first = TestMLXTransport(mode: .staleStreamLateChunk)
        let replacement = TestMLXTransport(mode: .staleStreamLateChunk)
        let factory = TestMLXTransportFactory([first, replacement])
        let synthesizer = TalkMLXSpeechSynthesizer(
            transportFactory: { try await factory.make() },
            idleDuration: .seconds(60))
        let firstSynthesis = Task {
            try await self.collectSynthesis(synthesizer, text: "first pressure fallback")
        }
        await first.waitForPendingEventRead()
        await synthesizer.handleMemoryPressure()
        let replacementSynthesis: Task<(sampleRate: Double, pcm: Data), Error>?
        if pressureOnReplacement {
            replacementSynthesis = Task {
                try await self.collectSynthesis(synthesizer, text: "replacement pressure fallback")
            }
            await replacement.waitForPendingEventRead()
        } else {
            replacementSynthesis = nil
        }
        await synthesizer.handleMemoryPressure()
        await first.cancelFirstSynthesis()
        do {
            _ = try await firstSynthesis.value
            Issue.record("expected first request to require fallback")
        } catch TalkMLXSpeechSynthesizer.SynthesizeError.audioGenerationFailed {} catch {
            Issue.record("repeated pressure lost the first request's fallback: \(error)")
        }
        if let replacementSynthesis {
            await replacement.cancelFirstSynthesis()
            do {
                _ = try await replacementSynthesis.value
                Issue.record("expected replacement request to require fallback")
            } catch TalkMLXSpeechSynthesizer.SynthesizeError.audioGenerationFailed {} catch {
                Issue.record("earlier request completion lost the replacement's fallback: \(error)")
            }
            #expect(await replacement.closeCount == 1)
        }
        #expect(await first.closeCount == 1)
        await synthesizer.shutdown()
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
            try await self.collectSynthesis(synthesizer, text: "never ready")
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

        _ = try await self.collectSynthesis(synthesizer, text: "brief")
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
        let audio = try await self.collectSynthesis(synthesizer, text: "legacy helper")

        #expect(audio.sampleRate == 32000)
        #expect(audio.pcm == Data([0x00, 0x00, 0xFF, 0x7F]))
        await synthesizer.shutdown()
    }

    private func collectSynthesis(
        _ synthesizer: TalkMLXSpeechSynthesizer,
        text: String,
        modelRepo: String? = nil,
        language: String? = nil,
        voicePreset: String? = nil) async throws -> (sampleRate: Double, pcm: Data)
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
    case cancelGraceTimedOut
    case closed
}

private actor TestMLXTransport: MLXTTSTransport {
    enum Mode: Equatable, Sendable {
        case audio
        case audioAfterCancel
        case crash
        case errorAfterCancel
        case ignoreCancel
        case staleStartupClose
        case staleStartupReady
        case staleStreamTimeout
        case staleStreamLateAudio
        case staleStreamLateChunk
        case streamAudioAfterCancel
        case startupHang
        case stream
        case streamIgnoreCancel
        case streamWaitForCancel
        case waitForCancel
    }

    let mode: Mode
    private(set) var sent: [MLXTTSRequest] = []
    private(set) var closeCount = 0
    private var events: [MLXTTSEvent] = [.ready]
    private var closed = false
    private var pendingEventRead = false
    private let holdsFirstCancelSend: Bool
    private var heldCancelID: String?
    private var cancelSendReleased = false

    init(mode: Mode, holdsFirstCancelSend: Bool = false) {
        self.mode = mode
        self.holdsFirstCancelSend = holdsFirstCancelSend
        if mode == .startupHang || mode == .staleStartupClose || mode == .staleStartupReady {
            self.events = []
        }
    }

    func send(_ request: MLXTTSRequest) async {
        self.sent.append(request)
        if case let .cancel(id) = request, self.holdsFirstCancelSend, self.heldCancelID == nil {
            self.heldCancelID = id
            while !self.cancelSendReleased {
                await Task.yield()
            }
        }
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
            case .staleStreamTimeout, .streamWaitForCancel, .streamIgnoreCancel, .streamAudioAfterCancel,
                 .staleStreamLateAudio, .staleStreamLateChunk:
                self.events.append(.streamStarted(MLXTTSStreamStart(
                    id: synthesize.id,
                    sampleRate: 32000)))
            case .crash:
                self.closed = true
            case .audioAfterCancel, .errorAfterCancel, .ignoreCancel, .staleStartupClose, .staleStartupReady,
                 .startupHang, .waitForCancel:
                break
            }
        case let .cancel(id):
            if self.mode == .audioAfterCancel || self.mode == .streamAudioAfterCancel {
                self.events.append(.audio(MLXTTSAudio(
                    id: id,
                    sampleRate: 32000,
                    pcm: Data([0x00, 0x00, 0xFF, 0x7F]))))
            } else if self.mode == .errorAfterCancel {
                self.events.append(.error(MLXTTSErrorEvent(
                    id: id,
                    code: .generationFailed,
                    message: "helper failed after cancellation")))
            } else if self.mode != .ignoreCancel,
                      self.mode != .streamIgnoreCancel,
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
        if self.holdsFirstCancelSend {
            self.closed = true
            return
        }
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

    func releaseCancelSend() {
        self.cancelSendReleased = true
    }

    func waitForClose() async throws {
        while self.closeCount == 0 {
            try Task.checkCancellation()
            await Task.yield()
        }
    }

    func cancelFirstSynthesis() {
        guard let request = self.sent.first, case let .synthesize(synthesize) = request else {
            Issue.record("expected a synthesis request before cancellation")
            return
        }
        self.events.append(.canceled(id: synthesize.id))
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
    private let holdsFirstCall: Bool
    private var firstCallReleased = false

    init(_ transports: [TestMLXTransport], holdsFirstCall: Bool = false) {
        self.transports = transports
        self.holdsFirstCall = holdsFirstCall
    }

    func make() async throws -> any MLXTTSTransport {
        self.callCount += 1
        guard !self.transports.isEmpty else {
            throw TestMLXTransportError.closed
        }
        let transport = self.transports.removeFirst()
        if self.holdsFirstCall, self.callCount == 1 {
            while !self.firstCallReleased {
                await Task.yield()
            }
        }
        return transport
    }

    func releaseFirstCall() {
        self.firstCallReleased = true
    }

    func waitForCall() async {
        while self.callCount == 0 {
            await Task.yield()
        }
    }
}
#endif
