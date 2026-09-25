import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

private func hintCatalog(overrides: [String: Any] = [:], configured: Bool = true) throws -> Data {
    var capability: [String: Any] = [
        "version": 1, "kind": "local-stop-phrases", "mode": "realtime", "transport": "gateway-relay",
        "models": ["gpt-realtime-2.1"], "transcriptionModel": "gpt-4o-mini-transcribe",
        "maxPhrases": 8, "maxPhraseUtf16Units": 64, "maxTotalUtf16Units": 256, "maxPromptUtf8Bytes": 1024,
    ]
    capability.merge(overrides) { _, new in new }
    return try JSONSerialization.data(withJSONObject: [
        "realtime": ["providers": [[
            "id": "openai", "configured": configured, "transcriptionCommandHints": capability,
        ]]],
    ])
}

struct RealtimeTalkTranscriptionHintsTests {
    @Test func `limits use UTF16 and reject entire invalid phrase sets`() {
        #expect(RealtimeTalkTranscriptionHints.accepts(Array(repeating: "end talking", count: 8)))
        #expect(RealtimeTalkTranscriptionHints.accepts(Array(repeating: String(repeating: "界", count: 64), count: 4)))
        #expect(RealtimeTalkTranscriptionHints.accepts([String(repeating: "😀", count: 32)]))
        #expect(RealtimeTalkTranscriptionHints.accepts(["arre\u{0302}te", "finish (now)", "End  Talking"]))
        let invalid: [[String]] = [
            [], [""], [" end talking"], ["end talking "], ["stop\ntalking"], ["stop\ttalking"],
            ["end\u{200B}talking"], ["end\u{2028}talking"], ["end\u{2029}talking"],
            Array(repeating: "end talking", count: 9), [String(repeating: "😀", count: 33)],
            Array(repeating: String(repeating: "a", count: 64), count: 4) + ["x"],
            ["end talking", String(repeating: "a", count: 65)],
        ]
        for phrases in invalid {
            #expect(!RealtimeTalkTranscriptionHints.accepts(phrases))
        }
    }

    @Test func `capability requires the reviewed route version model and bounds`() throws {
        #expect(try RealtimeTalkTranscriptionHints.isSupported(catalog: hintCatalog()))
        #expect(try !RealtimeTalkTranscriptionHints.isSupported(catalog: hintCatalog(configured: false)))
        let changes: [[String: Any]] = [
            ["version": 2], ["version": true], ["version": "1"], ["kind": "other"],
            ["mode": "transcription"], ["transport": "webrtc"], ["models": ["other-model"]],
            ["transcriptionModel": "other-model"], ["maxPhrases": 9], ["maxPhraseUtf16Units": 65],
            ["maxTotalUtf16Units": 257], ["maxPromptUtf8Bytes": 1025],
        ]
        for change in changes {
            #expect(try !RealtimeTalkTranscriptionHints.isSupported(catalog: hintCatalog(overrides: change)))
        }
        #expect(!RealtimeTalkTranscriptionHints.isSupported(catalog: Data("{}".utf8)))
    }
}

private enum HintTestError: Error {
    case unavailable
    case createRecorded
}

@MainActor
private final class HintTestRoute {
    var isCurrent = true
}

@MainActor
struct RealtimeTalkRelaySessionHintsTests {
    private func recordCreate(
        phrases: [String]?,
        provider: String? = "openai",
        model: String? = "gpt-realtime-2.1",
        supportsVoiceSelection: Bool = false,
        voiceChangeId: String? = nil,
        speechLocaleID: String? = nil,
        catalog: Data?) async throws -> [RealtimeRelayStartupRequest]
    {
        let requests = RealtimeRelayStartupRequestLog()
        let channel = AsyncStream<EventFrame>.makeStream()
        defer { channel.continuation.finish() }
        let capture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: .init(
                subscribeServerEvents: { _ in channel.stream },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    if method == "talk.catalog", let catalog { return catalog }
                    if method == "talk.session.create" { throw HintTestError.createRecorded }
                    throw HintTestError.unavailable
                }),
            options: .init(
                sessionKey: "main",
                provider: provider,
                model: model,
                voice: nil,
                localStopPhrases: phrases,
                speechLocaleID: speechLocaleID,
                supportsVoiceSelection: supportsVoiceSelection,
                voiceChangeId: voiceChangeId),
            audioCapture: capture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        do {
            try await session.start()
            Issue.record("Expected synthetic create boundary")
        } catch HintTestError.createRecorded {} catch {
            Issue.record("Unexpected startup error")
        }
        session.stop()
        #expect(!capture.isStarted)
        return await requests.snapshot()
    }

    @Test func `explicit Talk language reaches relay while automatic replacement clears it`() async throws {
        let cases: [(String?, String?)] = [
            ("en-US", "en"), (" ru_RU ", "ru"), ("zh-Hant-TW", "zh"),
            (nil, nil), ("", nil), ("auto", nil), ("AUTO", nil), ("und", nil),
            ("fil-PH", nil), ("haw-US", nil),
            ("not a locale", nil), ("xx-XX", nil), ("en-US", "en"), (nil, nil),
        ]
        for (locale, expected) in cases {
            let recorded = try await self.recordCreate(phrases: nil, speechLocaleID: locale, catalog: nil)
            #expect(recorded.map(\.method) == ["talk.session.create"])
            #expect(recorded.last?.params?["language"]?.stringValue == expected)
            #expect(recorded.last?.params?["transcriptionHints"] == nil)
        }
    }

    @Test func `negotiated custom phrases reach the actual create request unchanged`() async throws {
        let phrases = ["arre\u{0302}te", "Finish  (now)!", "会話を終了"]
        let recorded = try await self.recordCreate(phrases: phrases, catalog: hintCatalog())
        #expect(recorded.map(\.method) == ["talk.catalog", "talk.session.create"])
        #expect(recorded.first?.params?["provider"]?.stringValue == "openai")
        #expect(recorded.first?.params?["model"]?.stringValue == "gpt-realtime-2.1")
        let params = try #require(recorded.last?.params)
        let hints = try #require(params["transcriptionHints"]?.dictionaryValue)
        #expect(hints["version"]?.intValue == 1)
        #expect(hints["kind"]?.stringValue == "local-stop-phrases")
        let values = hints["phrases"]?.arrayValue?.compactMap(\.stringValue)
        let actual = try #require(values)
        #expect(actual.map { Array($0.utf8) } == phrases.map { Array($0.utf8) })
        #expect(params["model"]?.stringValue == "gpt-realtime-2.1")
    }

    @Test func `transcription hints preserve voice selection capability and replacement identity`() async throws {
        let requests = try await self.recordCreate(
            phrases: ["end talking"],
            supportsVoiceSelection: true,
            voiceChangeId: "voice-change-fixture",
            catalog: hintCatalog())
        let params = try #require(requests.last?.params)
        #expect(params["transcriptionHints"]?.dictionaryValue?["phrases"]?.arrayValue?
            .compactMap(\.stringValue) == ["end talking"])
        #expect(params["capabilities"]?.arrayValue?.compactMap(\.stringValue) == ["voice-selection"])
        #expect(params["voiceChangeId"]?.stringValue == "voice-change-fixture")
    }

    @Test func `ordinary and ineligible sessions do not discover or send hints`() async throws {
        for phrases: [String]? in [nil, [], ["invalid\nphrase"], Array(repeating: "x", count: 9)] {
            let requests = try await self.recordCreate(phrases: phrases, catalog: hintCatalog())
            #expect(requests.map(\.method) == ["talk.session.create"])
            #expect(requests.first?.params?["transcriptionHints"] == nil)
        }
        for (provider, model): (String?, String?) in [(nil, nil), ("other", "gpt-realtime-2.1"), ("openai", nil)] {
            let requests = try await self.recordCreate(
                phrases: ["end talking"], provider: provider, model: model, catalog: hintCatalog())
            #expect(requests.map(\.method) == ["talk.session.create"])
            #expect(requests.first?.params?["transcriptionHints"] == nil)
        }
    }

    @Test func `failed missing or unsupported catalog preserves legacy request without retries`() async throws {
        for catalog: Data? in try [nil, Data("{}".utf8), Data("invalid".utf8), hintCatalog(overrides: ["version": 2])] {
            let requests = try await self.recordCreate(phrases: ["end talking"], catalog: catalog)
            #expect(requests.map(\.method) == ["talk.catalog", "talk.session.create"])
            #expect(requests.last?.params?["transcriptionHints"] == nil)
            #expect(Set(requests.last?.params?.keys.map(\.self) ?? []) == [
                "sessionKey", "mode", "transport", "brain", "provider", "model",
            ])
        }
    }

    @Test(arguments: ["stop", "route", "event stream"])
    func `retirement during catalog lookup prevents session allocation`(reason: String) async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let entered = RealtimeRelayTestSignal<Void>()
        let release = RealtimeRelayTestSignal<Void>()
        let issue = RealtimeRelayTestSignal<Void>()
        let channel = AsyncStream<EventFrame>.makeStream()
        defer { channel.continuation.finish() }
        let route = HintTestRoute()
        let catalog = try hintCatalog()
        let capture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: .init(
                subscribeServerEvents: { _ in channel.stream },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    guard method == "talk.catalog" else { throw HintTestError.createRecorded }
                    entered.send(())
                    _ = try await release.next("catalog release")
                    return catalog
                },
                isCurrent: { @MainActor in route.isCurrent }),
            options: .init(
                sessionKey: "main",
                provider: "openai",
                model: "gpt-realtime-2.1",
                voice: nil,
                localStopPhrases: ["end talking"]),
            audioCapture: capture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { _ in issue.send(()) },
            onSpeakingChanged: { _ in })
        let start = Task { () -> Bool in
            do { try await session.start()
                return false
            } catch { return true }
        }
        do {
            _ = try await entered.next("catalog request")
            switch reason {
            case "stop": session.stop()
            case "route": route.isCurrent = false
            default:
                channel.continuation.finish()
                _ = try await issue.next("event stream failure")
            }
            release.send(())
            #expect(await start.value == (reason != "stop"))
        } catch {
            release.send(())
            session.stop()
            _ = await start.value
            throw error
        }
        #expect(await requests.snapshot().map(\.method) == ["talk.catalog"])
        #expect(!capture.isStarted)
        session.stop()
    }
}
