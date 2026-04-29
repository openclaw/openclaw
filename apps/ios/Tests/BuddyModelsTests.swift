import Testing
@testable import OpenClaw

@Suite struct BuddyModelsTests {
    @Test func listeningSnapshotUsesNemoIdentity() {
        let snapshot = BuddySnapshot.listening()

        #expect(snapshot.agent.name == "Nemo")
        #expect(snapshot.voice.wakeWord == "NemoNemo")
        #expect(snapshot.state == .listening)
        #expect(snapshot.agent.mood == .calm)
    }

    @Test func priorityChoosesPermissionBeforeConfirmation() {
        let state = BuddyState.resolve(
            permissionRequired: true,
            confirmationRequired: true,
            recording: true,
            visionScanning: true,
            speaking: true,
            executing: true,
            thinking: true,
            connected: true
        )

        #expect(state == .permissionRequired)
    }

    @Test func priorityChoosesConfirmationBeforeRecording() {
        let state = BuddyState.resolve(
            permissionRequired: false,
            confirmationRequired: true,
            recording: true,
            visionScanning: false,
            speaking: false,
            executing: false,
            thinking: false,
            connected: true
        )

        #expect(state == .needsConfirmation)
    }

    @Test func priorityFallsBackToDisconnectedBeforeListening() {
        let state = BuddyState.resolve(
            permissionRequired: false,
            confirmationRequired: false,
            recording: false,
            visionScanning: false,
            speaking: false,
            executing: false,
            thinking: false,
            connected: false
        )

        #expect(state == .disconnected)
    }

    @Test func priorityChoosesExecutingBeforeThinking() {
        let state = BuddyState.resolve(
            permissionRequired: false,
            confirmationRequired: false,
            recording: false,
            visionScanning: false,
            speaking: false,
            executing: true,
            thinking: true,
            connected: true
        )

        #expect(state == .executing)
    }

    @Test func builderShowsAssistantReplyWhileVoiceModeRemainsActive() {
        let snapshot = BuddySnapshotBuilder.build(
            connected: true,
            recording: true,
            speaking: true,
            assistantMessage: "我在这里。"
        )

        #expect(snapshot.state == .speaking)
        #expect(snapshot.agent.mood == .happy)
        #expect(snapshot.agent.message == "我在这里。")
    }

    @Test func builderMapsVisionScanningToFriendlyCopy() {
        let snapshot = BuddySnapshotBuilder.build(
            connected: true,
            recording: false,
            speaking: false,
            visionScanning: true
        )

        #expect(snapshot.state == .visionScanning)
        #expect(snapshot.agent.mood == .curious)
        #expect(snapshot.agent.message == "让我看一下")
    }
}
