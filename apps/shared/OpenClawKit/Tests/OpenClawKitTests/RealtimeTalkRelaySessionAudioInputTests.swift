import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

@MainActor
struct RealtimeTalkRelaySessionAudioInputTests {
    @Test func `input pause and resume are idempotent and keep relay alive`() throws {
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        try session.setInputPaused(true)
        try session.setInputPaused(true)
        try session.setInputPaused(false)
        try session.setInputPaused(false)

        #expect(audioCapture.stopCount == 2)
        #expect(audioCapture.startCount == 1)
        #expect(audioCapture.isStarted)
    }

    @Test func `microphone failure terminates relay and reports typed issue`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let issueObserved = RealtimeRelayTestSignal<RealtimeTalkRelayIssue>()
        let terminationObserved = RealtimeRelayTestSignal<RealtimeTalkRelayTermination>()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { _ in } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let audioCapture = TestRealtimeTalkAudioCapture()
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: {
                issues.append($0)
                issueObserved.send($0)
            },
            onTermination: {
                terminations.append($0)
                terminationObserved.send($0)
            },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        try session._test_startMicrophonePump()

        audioCapture.fail("Realtime microphone became unavailable: no input")
        _ = try await issueObserved.next("microphone failure issue")
        _ = try await terminationObserved.next("microphone failure termination")
        try await requests.waitForRequestCount(1)

        #expect(issues.map(\.code) == ["audio_input_unavailable"])
        #expect(issues.map(\.phase) == ["audio-input"])
        #expect(terminations == [.audioInputFailed(
            message: "Realtime microphone became unavailable: no input")])
        #expect(!audioCapture.isStarted)
        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.close"])
        #expect(recorded.first?.params?["sessionId"]?.stringValue == "relay-1")
    }

    @Test func `stop and pause retire buffered audio while resume admits a fresh frame`() async throws {
        let stoppedRequests = ControlledRealtimeAudioRequests()
        var stoppedStatuses: [String] = []
        var stoppedIssues: [RealtimeTalkRelayIssue] = []
        var stoppedTerminations: [RealtimeTalkRelayTermination] = []
        let stoppedSession = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, _ in try await stoppedRequests.request(method: method) }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { stoppedStatuses.append($0) },
            onIssue: { stoppedIssues.append($0) },
            onTermination: { stoppedTerminations.append($0) },
            onSpeakingChanged: { _ in })
        stoppedSession._test_setRelaySessionId("relay-1")
        stoppedSession._test_prepareAudioSender(relaySessionId: "relay-1")
        let stoppedSend = try #require(stoppedSession._test_enqueueMicrophoneFrame(Data([0x01])))
        do {
            try await stoppedRequests.waitForRequestCount(1)
            stoppedSession.stop()
            try await stoppedRequests.waitForRequestCount(2)
        } catch {
            stoppedSession.stop()
            await stoppedRequests.succeedPendingAppends()
            await stoppedSend.value
            throw error
        }
        await stoppedRequests.succeedPendingAppends()
        await stoppedRequests.succeedPendingAppends()
        await stoppedSend.value
        #expect(await stoppedRequests.snapshot() == [
            "talk.session.appendAudio",
            "talk.session.close",
        ])
        #expect(stoppedStatuses.isEmpty)
        #expect(stoppedIssues.isEmpty)
        #expect(stoppedTerminations.isEmpty)

        let requests = ControlledRealtimeAudioRequests()
        var statuses: [String] = []
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, _ in try await requests.request(method: method) }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        let pausedSend = try #require(session._test_enqueueMicrophoneFrame(Data([0x01])))
        var resumedSend: Task<Void, Never>?
        do {
            try await requests.waitForRequestCount(1)
            try session.setInputPaused(true)
            #expect(await requests.snapshot() == ["talk.session.appendAudio"])
            try session.setInputPaused(false)
            guard let freshSend = session._test_enqueueMicrophoneFrame(Data([0x02])) else {
                throw RealtimeRelayTestTimeout(operation: "resumed microphone frame admission")
            }
            resumedSend = freshSend
            try await requests.waitForRequestCount(2)
        } catch {
            session.stop()
            await requests.succeedPendingAppends()
            await pausedSend.value
            await resumedSend?.value
            throw error
        }
        await requests.succeedPendingAppends()
        await requests.succeedPendingAppends()
        await pausedSend.value
        await resumedSend?.value
        #expect(await requests.snapshot() == [
            "talk.session.appendAudio",
            "talk.session.appendAudio",
        ])
        session.stop()
        try await requests.waitForRequestCount(3)
        #expect(await requests.snapshot() == [
            "talk.session.appendAudio",
            "talk.session.appendAudio",
            "talk.session.close",
        ])
        #expect(statuses.isEmpty)
        #expect(issues.isEmpty)
        #expect(terminations.isEmpty)
    }

    @Test func `appended audio timestamps stay whole milliseconds`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_prepareAudioSender(relaySessionId: "relay-1")

        // macOS taps stamp frames with `systemUptime * 1000`, so the raw value is fractional.
        let send = try #require(
            session._test_enqueueMicrophoneFrame(Data([0x01, 0x02]), timestampMs: 4823.617))
        await send.value

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.appendAudio"])
        // A decimal reaches the provider as a non-integer `audio_end_ms` and its
        // `conversation.item.truncate` is rejected, ending the session on the first barge-in.
        let timestamp = try #require(recorded.first?.params?["timestamp"]?.value as? Double)
        #expect(timestamp == 4824)
        #expect(timestamp == timestamp.rounded())
    }

    @Test func `input past the audio budget is dropped without ending the call`() async throws {
        let requests = ControlledRealtimeAudioRequests()
        var statuses: [String] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, _ in try await requests.request(method: method) }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        try session._test_startMicrophonePump()
        // One second of PCM16 at the default 24 kHz; three fill the in-flight budget.
        let oneSecond = Data(count: 48000)

        var pending: [Task<Void, Never>] = []
        for _ in 0..<3 {
            try pending.append(#require(session._test_enqueueMicrophoneFrame(oneSecond)))
        }
        try await requests.waitForRequestCount(3)
        #expect(session._test_enqueueMicrophoneFrame(oneSecond) == nil)
        #expect(session._test_enqueueMicrophoneFrame(oneSecond) == nil)
        let behind = "Realtime audio input fell behind; repeat the last part"
        #expect(statuses == [behind])

        await requests.succeedPendingAppends()
        for task in pending {
            await task.value
        }
        let resumed = try #require(session._test_enqueueMicrophoneFrame(oneSecond))
        try await requests.waitForRequestCount(4)

        #expect(statuses == [behind, "Microphone input recovered; repeat the last part"])
        #expect(terminations.isEmpty)
        #expect(await requests.snapshot() == Array(repeating: "talk.session.appendAudio", count: 4))

        session.stop()
        await requests.succeedPendingAppends()
        await resumed.value
    }

    @Test func `audio appends give a stalled Gateway thirty seconds to answer`() async throws {
        // The transport owns the clock and fails a request at this deadline; the Gateway answers
        // appends in order, so this deadline is the relay's liveness window.
        let (appendDeadlines, appendDeadline) = AsyncStream.makeStream(of: Double.self)
        var terminations: [RealtimeTalkRelayTermination] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, timeoutMs in
                    if method == "talk.session.appendAudio" {
                        appendDeadline.yield(timeoutMs)
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "xai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        try session._test_startMicrophonePump()

        let send = try #require(session._test_enqueueMicrophoneFrame(Data([0x01, 0x02])))
        await send.value
        appendDeadline.finish()

        var deadlinesMs: [Double] = []
        for await timeoutMs in appendDeadlines {
            deadlinesMs.append(timeoutMs)
        }
        #expect(deadlinesMs == [30000])
        #expect(terminations.isEmpty)
    }

    @Test func `active audio request and response failures share the input failure owner`() async throws {
        for behavior in [ControlledAudioAppendBehavior.requestFailure, .malformedResponse] {
            let requests = ControlledRealtimeAudioRequests(behavior: behavior)
            let audioCapture = TestRealtimeTalkAudioCapture()
            var statuses: [String] = []
            var issues: [RealtimeTalkRelayIssue] = []
            var terminations: [RealtimeTalkRelayTermination] = []
            let session = RealtimeTalkRelaySession(
                transport: RealtimeTalkRelayTransport(
                    subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                    request: { method, _, _ in try await requests.request(method: method) }),
                options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
                audioCapture: audioCapture,
                pcmPlayer: UnusedPCMStreamingAudioPlayer(),
                onStatus: { statuses.append($0) },
                onIssue: { issues.append($0) },
                onTermination: { terminations.append($0) },
                onSpeakingChanged: { _ in })
            session._test_setRelaySessionId("relay-1")
            session._test_prepareAudioSender(relaySessionId: "relay-1")
            try session._test_startMicrophonePump()
            let stopCountBeforeFailure = audioCapture.stopCount

            let send = try #require(session._test_enqueueMicrophoneFrame(Data([0x01])))
            await send.value
            try await requests.waitForRequestCount(2)

            let issue = try #require(issues.first)
            #expect(issue.code == "audio_input_unavailable")
            #expect(issue.phase == "audio-input")
            #expect(statuses == [issue.message])
            #expect(terminations == [.audioInputFailed(message: issue.message)])
            #expect(audioCapture.stopCount == stopCountBeforeFailure + 1)
            #expect(await requests.snapshot() == [
                "talk.session.appendAudio",
                "talk.session.close",
            ])
        }
    }
}
