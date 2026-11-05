import Foundation
import SwabbleKit
import Testing
import XCTest
@testable import OpenClaw

private actor VoiceWakeCommandBarrier {
    private var entered = false
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private(set) var observedCancellation: Bool?

    func suspend() async {
        self.entered = true
        for waiter in self.enteredWaiters {
            waiter.resume()
        }
        self.enteredWaiters.removeAll()
        await withCheckedContinuation { continuation in
            self.releaseContinuation = continuation
        }
        self.observedCancellation = Task.isCancelled
    }

    func waitUntilEntered() async {
        if self.entered {
            return
        }
        await withCheckedContinuation { continuation in
            self.enteredWaiters.append(continuation)
        }
    }

    func release() {
        self.releaseContinuation?.resume()
        self.releaseContinuation = nil
    }
}

@Suite(.serialized) struct VoiceWakeManagerStateTests {
    @Test @MainActor func `handle recognition callback restarts on error`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.isListening = true
        let recognitionGeneration = manager._test_recognitionGeneration()

        manager._test_handleRecognitionCallback(transcript: nil, segments: [], errorText: "boom")
        #expect(manager.statusText.contains("Recognizer error") == true)
        #expect(manager.isListening == false)
        #expect(manager._test_recognitionGeneration() > recognitionGeneration)

        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
    }

    @Test @MainActor func `command deduplication belongs to one recognition generation`() async throws {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        defer { manager.stop() }
        manager.triggerWords = ["openclaw"]
        manager.isEnabled = true
        manager.isListening = true
        let originalGeneration = manager._test_recognitionGeneration()
        let barrier = VoiceWakeCommandBarrier()
        let firstDelivery = XCTestExpectation(description: "first command completed")
        var enteredCommands = 0
        var deliveries: [String] = []
        manager.configure { command in
            let first = enteredCommands == 0
            enteredCommands += 1
            if first {
                await barrier.suspend()
            }
            deliveries.append(command)
            if first { firstDelivery.fulfill() }
        }

        let transcript = "openclaw hello"
        let triggerRange = try #require(transcript.range(of: "openclaw"))
        let commandRange = try #require(transcript.range(of: "hello"))
        let segments = [
            WakeWordSegment(text: "openclaw", start: 0, duration: 0.2, range: triggerRange),
            WakeWordSegment(text: "hello", start: 0.8, duration: 0.2, range: commandRange),
        ]
        func receive(generation: UInt64) {
            manager._test_handleRecognitionCallback(
                transcript: transcript,
                segments: segments,
                errorText: nil,
                recognitionGeneration: generation)
        }

        receive(generation: originalGeneration)
        await barrier.waitUntilEntered()
        receive(generation: originalGeneration)
        await barrier.release()
        #expect(await XCTWaiter.fulfillment(of: [firstDelivery], timeout: 5) == .completed)
        #expect(await barrier.observedCancellation == false)
        #expect(deliveries == ["hello"])

        manager.stop()
        manager.isEnabled = true
        manager.isListening = true
        manager.lastTriggeredCommand = nil
        let nextDelivery = XCTestExpectation(description: "same command in replacement capture completed")
        manager.configure { command in
            deliveries.append(command)
            nextDelivery.fulfill()
        }

        receive(generation: originalGeneration)
        #expect(manager.lastTriggeredCommand == nil)
        receive(generation: manager._test_recognitionGeneration())
        #expect(await XCTWaiter.fulfillment(of: [nextDelivery], timeout: 5) == .completed)
        #expect(deliveries == ["hello", "hello"])
        #expect(manager.lastTriggeredCommand == "hello")
    }

    @Test @MainActor func `failed Voice Wake delivery replaces the triggered status`() async throws {
        let appModel = NodeAppModel()
        let manager = appModel.voiceWake
        manager.triggerWords = ["openclaw"]
        manager.isEnabled = true

        let transcript = "openclaw hello"
        let triggerRange = try #require(transcript.range(of: "openclaw"))
        let commandRange = try #require(transcript.range(of: "hello"))
        manager._test_handleRecognitionCallback(
            transcript: transcript,
            segments: [
                WakeWordSegment(text: "openclaw", start: 0, duration: 0.2, range: triggerRange),
                WakeWordSegment(text: "hello", start: 0.8, duration: 0.2, range: commandRange),
            ],
            errorText: nil)

        for _ in 0..<100 where manager.statusText == "Triggered" {
            await Task.yield()
        }

        #expect(manager.statusText == "Gateway not connected")
    }

    @Test @MainActor func `suppression cancels an admitted command before dispatch`() async throws {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        let barrier = VoiceWakeCommandBarrier()
        actor CaptureBox {
            var value: String?
            func set(_ next: String) {
                self.value = next
            }
        }
        let capture = CaptureBox()
        manager.triggerWords = ["openclaw"]
        manager.isEnabled = true
        manager.isListening = true
        manager.configure { command in
            await barrier.suspend()
            guard !Task.isCancelled else {
                throw NSError(domain: "VoiceWakeManagerStateTests", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Stale delivery failed",
                ])
            }
            await capture.set(command)
        }

        let transcript = "openclaw hello"
        let triggerRange = try #require(transcript.range(of: "openclaw"))
        let commandRange = try #require(transcript.range(of: "hello"))
        manager._test_handleRecognitionCallback(
            transcript: transcript,
            segments: [
                WakeWordSegment(text: "openclaw", start: 0, duration: 0.2, range: triggerRange),
                WakeWordSegment(text: "hello", start: 0.8, duration: 0.2, range: commandRange),
            ],
            errorText: nil)
        await barrier.waitUntilEntered()

        manager.setSuppressed(true, reason: .pushToTalk)
        await barrier.release()
        for _ in 0..<100 {
            if await barrier.observedCancellation != nil {
                break
            }
            await Task.yield()
        }

        #expect(await barrier.observedCancellation == true)
        #expect(await capture.value == nil)
        #expect(manager.statusText == "Paused")
    }

    @Test(.testWaitLimit, arguments: ["focus", "gateway", "watch-target", "agent"]) @MainActor
    func `route changes cancel pending commands and retire buffered recognition`(change: String) async throws {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        try await withUserDefaults([
            VoiceWakePreferences.enabledKey: false,
            VoiceWakePreferences.triggerWordsKey: ["openclaw"],
            "talk.enabled": false,
            "gateway.autoconnect": false,
            "watch.execApproval.bridge.state.v1": nil,
        ]) {
            let model = NodeAppModel()
            let manager = model.voiceWake
            defer { manager.stop() }
            if change == "agent" {
                model.setSelectedAgentId("alpha")
            }
            model.focusChatSession("agent:main:original")
            if change == "agent" {
                // Talk can already target another agent while phone focus still
                // belongs to the old agent. Selecting it must retire that capture.
                model.synchronizeTalkSessionKey("agent:beta:main")
            } else if change == "watch-target" {
                // Watch-started Talk can leave its target after Talk stops;
                // phone focus must invalidate wake even when Talk already targets the next chat.
                model.synchronizeTalkSessionKey("agent:main:replacement")
            }
            manager.isEnabled = true
            manager.isListening = true
            let generation = manager._test_recognitionGeneration()
            let entered = AsyncTestGate()
            let release = AsyncTestGate()
            defer { release.open() }
            let finished = AsyncTestGate()
            let fresh = AsyncTestGate()
            var observedCancellation: Bool?
            var deliveries: [String] = []
            manager.configure { command in
                if command == "pending" {
                    entered.open()
                    await release.wait()
                    defer { finished.open() }
                    observedCancellation = Task.isCancelled
                    try Task.checkCancellation()
                }
                deliveries.append(command)
                if command == "fresh" { fresh.open() }
            }
            @MainActor func receive(_ command: String, generation: UInt64) throws {
                let transcript = "openclaw " + command
                try manager._test_handleRecognitionCallback(
                    transcript: transcript,
                    segments: [
                        WakeWordSegment(
                            text: "openclaw", start: 0, duration: 0.2,
                            range: #require(transcript.range(of: "openclaw"))),
                        WakeWordSegment(
                            text: command, start: 0.8, duration: 0.2,
                            range: #require(transcript.range(of: command))),
                    ],
                    errorText: nil,
                    recognitionGeneration: generation)
            }

            try receive("pending", generation: generation)
            try await entered.wait("wake command admitted")
            if change == "gateway" {
                await model.resetGatewaySessionsForTargetSwitch()
            } else if change == "agent" {
                model.setSelectedAgentId("beta")
                #expect(model.mainSessionKey == "agent:beta:main")
                #expect(model.focusedChatSessionKey == nil)
            } else {
                model.focusChatSession("agent:main:replacement")
            }
            release.open()
            try await finished.wait("retired wake command settled")
            #expect(observedCancellation == true)
            #expect(deliveries.isEmpty)

            try receive("stale", generation: generation)
            #expect(manager.lastTriggeredCommand == "pending")
            try receive("fresh", generation: manager._test_recognitionGeneration())
            try await fresh.wait("current recognition delivered")
            #expect(deliveries == ["fresh"])
        }
    }

    @Test @MainActor func `Voice Wake deactivates only its owned audio session`() {
        var deactivationCount = 0
        let manager = VoiceWakeManager._test_withoutRestartDelays {
            deactivationCount += 1
        }

        manager.stop()
        #expect(deactivationCount == 0)

        manager._test_setAudioSessionIsActive(true)
        manager.stop()
        manager.stop()
        #expect(deactivationCount == 1)
    }
}
