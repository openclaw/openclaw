import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MeetingDetectorTests {
    @Test func sharedInstanceExists() {
        let detector = MeetingDetector.shared
        #expect(detector.currentSession == nil)
    }

    @Test func defaultSettingsState() {
        let detector = MeetingDetector.shared
        // Detector should not have an active session by default
        #expect(detector.currentSession == nil)
        #expect(detector.upcomingMeetings.isEmpty)
    }

    @Test func meetingDetectionTogglePersists() {
        let detector = MeetingDetector.shared
        let original = detector.meetingDetectionEnabled

        detector.meetingDetectionEnabled = true
        #expect(detector.meetingDetectionEnabled == true)

        detector.meetingDetectionEnabled = false
        #expect(detector.meetingDetectionEnabled == false)

        // Restore
        detector.meetingDetectionEnabled = original
    }

    @Test func adHocDetectionTogglePersists() {
        let detector = MeetingDetector.shared
        let original = detector.adHocDetectionEnabled

        detector.adHocDetectionEnabled = false
        #expect(detector.adHocDetectionEnabled == false)

        detector.adHocDetectionEnabled = true
        #expect(detector.adHocDetectionEnabled == true)

        // Restore
        detector.adHocDetectionEnabled = original
    }

    @Test func startMeetingCreatesSession() async {
        let detector = MeetingDetector.shared
        // Ensure no session is active
        if detector.currentSession != nil {
            await detector.stopMeeting()
        }

        await detector.startMeeting(title: "Test Meeting")
        #expect(detector.currentSession != nil)
        #expect(detector.currentSession?.title == "Test Meeting")
        #expect(detector.currentSession?.status == .recording)

        // Clean up
        await detector.stopMeeting()
        #expect(detector.currentSession == nil)
    }

    @Test func startMeetingWhileActiveLogs() async {
        let detector = MeetingDetector.shared
        if detector.currentSession != nil {
            await detector.stopMeeting()
        }

        await detector.startMeeting(title: "First")
        #expect(detector.currentSession?.title == "First")

        // Starting another should not replace the existing one
        await detector.startMeeting(title: "Second")
        #expect(detector.currentSession?.title == "First")

        await detector.stopMeeting()
    }

    @Test func stopMeetingSavesToStore() async {
        let detector = MeetingDetector.shared
        if detector.currentSession != nil {
            await detector.stopMeeting()
        }

        await detector.startMeeting(title: "Save Test \(UUID().uuidString.prefix(8))")
        let sessionId = detector.currentSession?.id
        #expect(sessionId != nil)

        await detector.stopMeeting()
        #expect(detector.currentSession == nil)

        // Verify it was saved
        if let sessionId {
            let store = MeetingStore.shared
            #expect(store.summaries.contains { $0.id == sessionId })
            // Clean up
            store.delete(id: sessionId)
        }
    }

    @Test func stopWithNoSessionIsNoOp() async {
        let detector = MeetingDetector.shared
        if detector.currentSession != nil {
            await detector.stopMeeting()
        }

        // Should not crash
        await detector.stopMeeting()
        #expect(detector.currentSession == nil)
    }

    @Test func startAndStopLifecycleDoesNotCrash() {
        let detector = MeetingDetector.shared
        let original = detector.meetingDetectionEnabled

        detector.meetingDetectionEnabled = true
        detector.start()
        detector.stop()

        detector.meetingDetectionEnabled = original
    }
}
