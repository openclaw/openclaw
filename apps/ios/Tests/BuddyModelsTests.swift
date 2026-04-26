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
            thinking: false,
            connected: false
        )

        #expect(state == .disconnected)
    }
}
