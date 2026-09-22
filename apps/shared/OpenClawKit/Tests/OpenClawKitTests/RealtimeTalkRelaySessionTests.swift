import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

@MainActor
struct RealtimeTalkRelaySessionTests {
    @Test(arguments: [false, true])
    func `voice selection is opt in and replacement carries its change id`(
        supportsVoiceSelection: Bool) async throws
    {
        let requests = RealtimeRelayStartupRequestLog()
        let events = AsyncStream<EventFrame>.makeStream()
        defer { events.continuation.finish() }
        let result = TalkSessionCreateResult(
            sessionid: "relay-1",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let options: RealtimeTalkRelaySession.Options = supportsVoiceSelection
            ? .init(
                sessionKey: "chat-1",
                provider: nil,
                model: nil,
                voice: nil,
                supportsVoiceSelection: true,
                voiceChangeId: "change-1")
            : .init(sessionKey: "chat-1", provider: nil, model: nil, voice: nil)
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in events.stream },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    if method == "talk.session.create" {
                        events.continuation.yield(EventFrame(
                            type: "event",
                            event: "talk.event",
                            payload: AnyCodable(["relaySessionId": "relay-1", "type": "ready"])))
                        return resultData
                    }
                    if method == "talk.catalog" {
                        return try realtimeRelayCatalogData()
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: options,
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        defer { session.stop() }
        #expect(session.voiceSessionId == nil)
        #expect(!session.isReady)

        try await session.start()

        #expect(session.voiceSessionId == "relay-1")
        #expect(session.isReady)
        let create = try #require(await requests.snapshot().first?.params)
        #expect(create["sessionKey"]?.stringValue == "chat-1")
        #expect(create["voiceChangeId"]?.stringValue == (supportsVoiceSelection ? "change-1" : nil))
        if supportsVoiceSelection {
            #expect(create["capabilities"]?.arrayValue?.compactMap(\.stringValue) == ["voice-selection"])
        } else {
            #expect(create["capabilities"] == nil)
        }

        try await session.stopAndWait()
        #expect(session.voiceSessionId == nil)
        #expect(!session.isReady)
    }

    @Test(arguments: [false, true])
    func `stop waiters share the pending server close and its result`(closeFails: Bool) async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        let waiterEntered = RealtimeRelayTestSignal<Void>()
        var completedWaiters = 0
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    if await requests.snapshot().count == 1 {
                        await barrier.suspend()
                    }
                    if closeFails { throw URLError(.networkConnectionLost) }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "chat-1", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session.stop()
        let waiters = (0..<2).map { _ in
            Task { @MainActor in
                defer { completedWaiters += 1 }
                waiterEntered.send(())
                try await session.stopAndWait()
            }
        }
        do {
            try await barrier.waitUntilEntered()
            for _ in waiters {
                _ = try await waiterEntered.next("close waiter entry")
            }
            session.stop()
            #expect(completedWaiters == 0)
            #expect(session.voiceSessionId == nil)
            #expect(!session.isReady)
            #expect(await requests.snapshot().map(\.method) == ["talk.session.close"])

            await barrier.release()
            for waiter in waiters {
                switch await waiter.result {
                case .success:
                    #expect(!closeFails)
                case let .failure(error):
                    #expect(closeFails)
                    #expect((error as? URLError)?.code == .networkConnectionLost)
                }
            }
            #expect(completedWaiters == 2)
            let recorded = await requests.snapshot()
            #expect(recorded.map(\.method) == ["talk.session.close"])
            #expect(recorded.first?.params?["sessionId"]?.stringValue == "relay-1")
        } catch {
            await barrier.release()
            for waiter in waiters {
                _ = await waiter.result
            }
            throw error
        }
    }

    @Test func `transcript callback carries typed partial and final values`() async {
        var transcripts: [RealtimeTalkTranscript] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in },
            onTranscript: { transcripts.append($0) })
        session._test_setRelaySessionId("relay-1")

        for isFinal in [false, true] {
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "transcript",
                    "role": "user",
                    "text": isFinal ? "hello" : "hel",
                    "final": isFinal,
                ]),
                seq: nil,
                stateversion: nil))
        }

        #expect(transcripts == [
            RealtimeTalkTranscript(role: "user", text: "hel", isFinal: false),
            RealtimeTalkTranscript(role: "user", text: "hello", isFinal: true),
        ])
    }

    @Test func `close after classified error does not replace issue`() async {
        var issues: [RealtimeTalkRelayIssue] = []
        var statuses: [String] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "error",
                "message": "OpenAI API key rejected with 401",
                "code": "realtime_unavailable",
                "provider": "openai",
                "model": "gpt-realtime-2",
                "transport": "gateway-relay",
                "phase": "connect",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "close",
                "reason": "error",
            ]),
            seq: nil,
            stateversion: nil))

        #expect(issues.map(\.code) == ["realtime_unavailable"])
        #expect(statuses == ["OpenAI API key rejected with 401"])
    }

    @Test func `provider failure revokes ready before the close event`() async {
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        defer { session.stop() }
        session._test_setRelaySessionId("relay-1")
        for type in ["ready", "error"] {
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable(["relaySessionId": "relay-1", "type": type])))
            #expect(session.isReady == (type == "ready"))
        }
    }

    @Test func `gateway-owned model is omitted and pre-ready failure closes created session`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let failureEvent = EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "error",
                "message": "OpenAI API key rejected with 401",
                "phase": "connect",
            ]),
            seq: nil,
            stateversion: nil)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in
                AsyncStream { continuation in
                    continuation.yield(failureEvent)
                }
            },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    return resultData
                }
                if method == "talk.catalog" {
                    return try realtimeRelayCatalogData()
                }
                return Data("{\"ok\":true}".utf8)
            })
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        do {
            try await session.start()
            Issue.record("Expected the pre-ready relay failure to throw")
        } catch {
            #expect(error.localizedDescription == "OpenAI API key rejected with 401")
        }

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.catalog", "talk.session.close"])
        let createParams = try #require(recorded.first?.params)
        #expect(!createParams.keys.contains("model"))
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
        #expect(!audioCapture.isStarted)
    }

    @Test(arguments: [true, false])
    func `pre-ready event stream end fails startup and closes created session once`(
        processedBeforeRegistration: Bool) async throws
    {
        let requests = RealtimeRelayStartupRequestLog()
        let eventChannel = AsyncStream<EventFrame>.makeStream()
        let issueObserved = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        let startupCompleted = RealtimeRelayTestSignal<Result<Void, any Error>>()
        let audioCapture = TestRealtimeTalkAudioCapture()
        var endedEventStream = false
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in eventChannel.stream },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    return resultData
                }
                if method == "talk.catalog" {
                    return try realtimeRelayCatalogData()
                }
                return Data("{\"ok\":true}".utf8)
            },
            isCurrent: { @MainActor () async -> Bool in
                guard audioCapture.isStarted, !endedEventStream else { return true }
                endedEventStream = true
                eventChannel.continuation.finish()
                // Suspending here lets the pump save the issue before waiter registration.
                // Otherwise this MainActor segment registers the waiter before the pump can run.
                if processedBeforeRegistration {
                    var iterator = issueObserved.stream.makeAsyncIterator()
                    _ = await iterator.next()
                }
                return true
            })
        var issues: [RealtimeTalkRelayIssue] = []
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: {
                issues.append($0)
                issueObserved.continuation.yield(())
            },
            onSpeakingChanged: { _ in })
        let start = Task { @MainActor in
            do {
                try await session.start()
                startupCompleted.send(.success(()))
            } catch {
                startupCompleted.send(.failure(error))
            }
        }
        defer {
            issueObserved.continuation.finish()
            eventChannel.continuation.finish()
            session.stop()
            start.cancel()
        }
        do {
            let startupResult = try await startupCompleted.next("relay startup completion after event stream end")
            await start.value
            switch startupResult {
            case .success:
                Issue.record("Expected the pre-ready event stream end to throw")
            case let .failure(error):
                let startupError = error as NSError
                #expect(startupError.domain == "RealtimeTalkRelay")
                #expect(startupError.code == 6)
                #expect(startupError.localizedDescription == "Realtime connection ended before it became ready.")
            }

            #expect(issues.map(\.phase) == ["connect"])
            let recorded = await requests.snapshot()
            #expect(recorded.map(\.method) == ["talk.session.create", "talk.catalog", "talk.session.close"])
            #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
            #expect(audioCapture.startCount == 1)
            #expect(!audioCapture.isStarted)
        } catch {
            issueObserved.continuation.finish()
            eventChannel.continuation.finish()
            session.stop()
            start.cancel()
            await start.value
            if audioCapture.startCount > 0 {
                try? await requests.waitForRequestCount(3)
            }
            throw error
        }
    }

    @Test func `event stream ending during relay creation closes the late relay`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let events = RealtimeRelayEventSource()
        let requests = RealtimeRelayStartupRequestLog()
        let audioCapture = TestRealtimeTalkAudioCapture()
        let issueNotification = AsyncStream.makeStream(
            of: RealtimeTalkRelayIssue.self, bufferingPolicy: .bufferingNewest(1))
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in await events.stream() },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    if method == "talk.session.create" {
                        await barrier.suspend()
                        return resultData
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issueNotification.continuation.yield($0) },
            onSpeakingChanged: { _ in })
        let start = Task { @MainActor in try await session.start() }
        do {
            try await barrier.waitUntilEntered()
            await events.finish()
            let issue = try await waitForRealtimeRelayEvent(
                issueNotification.stream,
                operation: "relay startup issue")
            await barrier.release()

            var caughtStartupError: NSError?
            do {
                try await start.value
                Issue.record("Expected relay startup to fail")
            } catch {
                caughtStartupError = error as NSError
            }
            let startupError = try #require(caughtStartupError)
            #expect(startupError.domain == "RealtimeTalkRelay")
            #expect(startupError.code == 6)
            #expect(issue.code == "realtime_unavailable")
            #expect(issue.phase == "connect")
            #expect(issue.transport == "gateway-relay")
            #expect(!issue.message.isEmpty)
            #expect(audioCapture.startCount == 0)
            let recorded = await requests.snapshot()
            #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
            #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
            issueNotification.continuation.finish()
        } catch {
            await barrier.release()
            session.stop()
            start.cancel()
            _ = try? await start.value
            issueNotification.continuation.finish()
            throw error
        }
    }

    @Test func `ready then close publishes one typed termination and releases capture`() async {
        var statuses: [String] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "ready",
            ]),
            seq: nil,
            stateversion: nil))
        let closeEvent = EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "close",
                "reason": "completed",
            ]),
            seq: nil,
            stateversion: nil)
        await session._test_handleGatewayEvent(closeEvent)
        await session._test_handleGatewayEvent(closeEvent)

        #expect(statuses == ["Listening (Realtime)", "Ready"])
        #expect(terminations == [.remoteClose(reason: "completed")])
        #expect(audioCapture.stopCount == 1)
        #expect(session.voiceSessionId == nil)
        #expect(!session.isReady)
    }

    @Test func `ready then event stream end publishes typed termination`() async {
        var terminations: [RealtimeTalkRelayTermination] = []
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "ready",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleEventStreamEnded()
        await session._test_handleEventStreamEnded()

        #expect(terminations == [.eventStreamEnded])
        #expect(audioCapture.stopCount == 1)
    }

    @Test func `closed relay does not wait for startup ready`() async {
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        session.stop()

        #expect(await session._test_waitForStartupCancelled(timeoutSeconds: 1))
    }

    @Test func `stop during event subscription prevents relay creation`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in
                await barrier.suspend()
                return AsyncStream { $0.finish() }
            },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                throw URLError(.badServerResponse)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        let start = Task { @MainActor in try await session.start() }
        try await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        #expect(await requests.snapshot().isEmpty)
        #expect(statuses == ["Connecting realtime…"])
        #expect(!speakingStates.contains(true))
    }

    @Test func `stop during relay creation closes late session once`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in
                AsyncStream { continuation in
                    continuation.yield(EventFrame(
                        type: "event",
                        event: "talk.event",
                        payload: AnyCodable(["relaySessionId": "relay-1", "type": "ready"])))
                }
            },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    await barrier.suspend()
                    return resultData
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        let start = Task { @MainActor in try await session.start() }
        try await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
        #expect(!statuses.contains("Waiting for realtime…"))
        #expect(!speakingStates.contains(true))
        #expect(session.voiceSessionId == nil)
        #expect(!session.isReady)
    }

    @Test(arguments: [false, true])
    func `stop settles independently of tool acceptance and fences late results`(
        toolAccepted: Bool) async throws
    {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        let events = AsyncStream<EventFrame>.makeStream()
        let closeCompleted = RealtimeRelayTestSignal<Result<Void, Error>>()
        defer { events.continuation.finish() }
        var statuses: [String] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in events.stream },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.client.toolCall" {
                    if !toolAccepted { await barrier.suspend() }
                    return Data("{\"runId\":\"run-1\"}".utf8)
                }
                return Data("{\"ok\":true}".utf8)
            },
            isCurrent: {
                if toolAccepted, await requests.snapshot().contains(where: { $0.method == "talk.client.toolCall" }) {
                    // Suspend after the ACK, while the accepted run retains its own lifetime.
                    await barrier.suspend()
                }
                return true
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        let handling = Task { @MainActor in
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "toolCall",
                    "callId": "call-1",
                    "name": "lookup",
                    "args": [:],
                ]),
                seq: nil,
                stateversion: nil))
        }
        try await barrier.waitUntilEntered()
        let closing = Task { @MainActor in
            do {
                try await session.stopAndWait()
                closeCompleted.send(.success(()))
            } catch {
                closeCompleted.send(.failure(error))
            }
        }
        do {
            try await closeCompleted.next("relay close while tool call is suspended").get()
            events.continuation.yield(EventFrame(
                type: "event",
                event: "chat",
                payload: AnyCodable([
                    "runId": "run-1",
                    "state": "final",
                    "message": "Accepted work finished after the transport closed.",
                ])))
            await barrier.release()
            await handling.value
            await session._test_waitForToolCalls()
            await closing.value

            let methods = await requests.snapshot().map(\.method)
            #expect(methods == ["talk.client.toolCall", "talk.session.close"])
            #expect(statuses == ["Thinking…"])
        } catch {
            await barrier.release()
            session.stop()
            await handling.value
            await session._test_waitForToolCalls()
            await closing.value
            throw error
        }
    }

    @Test(arguments: [false, true])
    func `gateway route lost during startup fails instead of reporting ready`(
        routeLostDuringCreate: Bool) async throws
    {
        let route = RealtimeRelayRouteFlag()
        let requests = RealtimeRelayStartupRequestLog()
        let audioCapture = TestRealtimeTalkAudioCapture()
        let result = TalkSessionCreateResult(
            sessionid: "relay-1",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in
                    if !routeLostDuringCreate { await route.expire() }
                    return AsyncStream { _ in }
                },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    if method == "talk.session.create" {
                        await route.expire()
                        return resultData
                    }
                    // Bound transports reject cleanup instead of retargeting a replacement socket.
                    throw CancellationError()
                },
                isCurrent: { await route.value() }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        do {
            try await session.start()
            Issue.record("Expected a lost Gateway route to fail startup")
        } catch is CancellationError {
            // The runtime returns silently on CancellationError, so classifying route loss as
            // cancellation would leave Talk marked listening with no relay and no fallback.
            Issue.record("Route loss must not surface as local cancellation")
        } catch {
            #expect(
                error.localizedDescription ==
                    "Gateway connection was replaced before realtime startup finished")
        }

        #expect(!audioCapture.isStarted)
        #expect(!session.isReady)
        #expect(session.voiceSessionId == nil)
        if routeLostDuringCreate {
            do {
                try await session.stopAndWait()
                Issue.record("Expected the retained close failure from the expired route")
            } catch is CancellationError {
                // Startup reports route loss; a later close waiter receives the same cleanup failure.
            }
        }
        let expectedMethods = routeLostDuringCreate ? ["talk.session.create", "talk.session.close"] : []
        #expect(await requests.snapshot().map(\.method) == expectedMethods)
    }
}
