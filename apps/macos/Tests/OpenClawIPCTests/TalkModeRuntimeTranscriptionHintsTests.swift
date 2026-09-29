import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

extension TalkModeRuntimeSpeechTests {
    @Test @MainActor func `relay language follows explicit Talk config and clears on replacement`() async throws {
        try #require(AppStateStore.shared.isPreview)
        let previousWakeLocale = AppStateStore.shared.voiceWakeLocaleID
        defer { AppStateStore.shared.voiceWakeLocaleID = previousWakeLocale }
        AppStateStore.shared.voiceWakeLocaleID = "ja-JP"
        let requests = RuntimeTestRelayRequestLog()
        let locales: [String?] = ["en-US", "ru_RU", nil, "auto"]
        let bootstraps = try locales.map { locale in
            try makeRuntimeTestBootstrap(requests: requests, speechLocaleID: locale)
        }
        let sequence = RuntimeTestBootstrapSequence(bootstraps: bootstraps)
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { try await sequence.next() })
        await runtime._test_setRealtimeAudioCaptureProvider { RuntimeTestAudioCapture() }
        for _ in locales {
            let lifecycle = await runtime._test_prepareEnabledLifecycle()
            await runtime._test_enableRealtimeRelaySelection()
            do {
                try await runtime.startRealtimeRelay(generation: lifecycle)
            } catch {
                await runtime.setEnabled(false)
                throw error
            }
            await runtime.setEnabled(false)
        }
        #expect(await requests.createdLanguages() == ["en", "ru", nil, nil])
    }

    @Test(arguments: [false, true]) @MainActor
    func `relay hints use current preferences and never retain command authority`(spokenEnabled: Bool) async throws {
        try #require(AppStateStore.shared.isPreview)
        let previous = AppStateStore.shared.talkStopPhrases
        let previousSpoken = AppStateStore.shared.talkSpokenExitAcknowledgementEnabled
        AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = spokenEnabled
        defer {
            AppStateStore.shared.talkStopPhrases = previous
            AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = previousSpoken
        }
        let catalog = Data(#"""
        {"realtime":{"providers":[{"id":"openai","configured":true,"transcriptionCommandHints":{
          "version":1,"kind":"local-stop-phrases","mode":"realtime","transport":"gateway-relay",
          "models":["gpt-realtime-2.1"],"transcriptionModel":"gpt-4o-mini-transcribe",
          "maxPhrases":8,"maxPhraseUtf16Units":64,"maxTotalUtf16Units":256,"maxPromptUtf8Bytes":1024
        }}]}}
        """#.utf8)
        for phrases: [String] in [["conversation finished"], []] {
            AppStateStore.shared.talkStopPhrases = phrases
            let requests = RuntimeTestRelayRequestLog()
            let bootstrap = try makeRuntimeTestBootstrap(
                requests: requests, realtimeModel: "gpt-realtime-2.1", catalog: catalog)
            let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { bootstrap })
            await runtime._test_setRealtimeAudioCaptureProvider { RuntimeTestAudioCapture() }
            let lifecycle = await runtime._test_prepareEnabledLifecycle()
            await runtime._test_enableRealtimeRelaySelection()
            do {
                try await runtime.startRealtimeRelay(generation: lifecycle)
                #expect(await requests.createdHintPhrases() == [phrases.isEmpty ? nil : phrases])
                #expect(await requests.snapshot().methods == (
                    phrases.isEmpty
                        ? ["talk.session.create", "talk.catalog"]
                        : ["talk.catalog", "talk.session.create", "talk.catalog"]))
                AppStateStore.shared.talkStopPhrases = []
                let relay = await runtime.realtimeRelayGeneration
                await runtime.handleRealtimeTranscript(
                    .init(role: "user", text: "conversation finished", isFinal: true), relayGeneration: relay)
                #expect(await runtime.isEnabled)
                #expect(await runtime.realtimeSession != nil)
            } catch {
                await runtime.setEnabled(false)
                throw error
            }
            await runtime.setEnabled(false)
        }
    }
}

extension TalkModeRuntimeSpeechTests {
    @Test(arguments: [false, true]) @MainActor
    func `relay exit guidance is independently negotiated and refreshes current phrases`(supported: Bool) async throws {
        try #require(AppStateStore.shared.isPreview)
        let previousSpoken = AppStateStore.shared.talkSpokenExitAcknowledgementEnabled
        AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = true
        let previous = AppStateStore.shared.talkStopPhrases
        let previousRelayPreference = AppStateStore.shared.talkRealtimeRelayEnabled
        AppStateStore.shared.talkRealtimeRelayEnabled = true
        defer {
            AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = previousSpoken
            AppStateStore.shared.talkStopPhrases = previous
            AppStateStore.shared.talkRealtimeRelayEnabled = previousRelayPreference
        }
        // This provider does not advertise transcription bias. Response guidance has
        // a distinct capability and must not silently borrow transcription authority.
        let catalog = Data((supported ? #"""
        {"realtime":{"providers":[{"id":"openai","configured":true,"localExitAcknowledgement":{
          "version":1,"mode":"realtime","transport":"gateway-relay",
          "maxPhrases":8,"maxPhraseUtf16Units":64,"maxTotalUtf16Units":256
        }}]}}
        """# : #"{"realtime":{"providers":[{"id":"openai","configured":true}]}}"#).utf8)
        let phraseSets = [["conversation finished"], ["that is all"], ["that is all"], ["that is all"], []]
        let spokenEnabled = [true, true, false, true, true]
        let requests = RuntimeTestRelayRequestLog()
        let bootstraps = try phraseSets.map { _ in
            try makeRuntimeTestBootstrap(requests: requests, realtimeModel: "gpt-realtime-2.1", catalog: catalog)
        }
        let sequence = RuntimeTestBootstrapSequence(bootstraps: bootstraps)
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { try await sequence.next() })
        await runtime._test_setRealtimeAudioCaptureProvider { RuntimeTestAudioCapture() }
        await runtime._test_setVoiceWakeReadiness(supported: true, permissionGranted: true)
        let lifecycle = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()
        AppStateStore.shared.talkStopPhrases = phraseSets[0]
        do {
            try await runtime.startRealtimeRelay(generation: lifecycle)
            for index in phraseSets.indices.dropFirst() {
                let phrases = phraseSets[index]
                AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = spokenEnabled[index]
                let oldSession = try #require(await runtime.realtimeSession)
                AppStateStore.shared.talkStopPhrases = phrases
                // Preview preferences deliberately do not dispatch to the live singleton.
                // Invoke the exact didSet target on this test-owned active runtime.
                await runtime.localTalkExitPreferencesDidChange()
                #expect(await runtime.isEnabled)
                #expect(await runtime.realtimeSession != nil)
                #expect(await runtime.realtimeSession !== oldSession)
            }
        } catch {
            await runtime.setEnabled(false)
            throw error
        }
        await runtime.setEnabled(false)
        #expect(await sequence.requestCount() == 5)
        #expect(await requests.snapshot().methods.filter { $0 == "talk.session.close" }.count == 5)
        #expect(await requests.createdExitPhrases() == (
            supported ? [["conversation finished"], ["that is all"], nil, ["that is all"], nil] : [
                nil,
                nil,
                nil,
                nil,
                nil,
            ]))
        #expect(await requests.createdHintPhrases() == [nil, nil, nil, nil, nil])
    }

    @Test(arguments: [false, true]) @MainActor
    func `exit preference changes preserve active native recognition`(spokenEnabled: Bool) async throws {
        let previousSpoken = AppStateStore.shared.talkSpokenExitAcknowledgementEnabled
        defer { AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = previousSpoken }
        let runtime = TalkModeRuntime()
        // A regression must fail by state mutation, never reach real permission UI.
        await runtime._test_setVoiceWakeReadiness(supported: false, permissionGranted: false)
        let lifecycle = await runtime._test_prepareEnabledLifecycle()
        let recognition = try #require(await runtime.beginRecognitionAttempt(lifecycleGeneration: lifecycle))
        AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = spokenEnabled
        await runtime.localTalkExitPreferencesDidChange()
        #expect(await runtime.isCurrent(lifecycle))
        #expect(await runtime.canCommitRecognitionStart(
            lifecycleGeneration: lifecycle, recognitionAttempt: recognition))
        #expect(await runtime.realtimeSession == nil)
        await runtime.setEnabled(false)
    }
}
