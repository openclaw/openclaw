import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MeetingViewSmokeTests {
    @Test func meetingSettingsBuildsBody() {
        let view = MeetingSettings()
        _ = view.body
    }

    @Test func meetingMenuItemsBuildsBodyWithNoSession() {
        MeetingDetector.shared.meetingDetectionEnabled = false
        let view = MeetingMenuItems()
        _ = view.body
    }

    @Test func meetingMenuItemsBuildsBodyWhenEnabled() {
        MeetingDetector.shared.meetingDetectionEnabled = true
        let view = MeetingMenuItems()
        _ = view.body
        // Reset
        MeetingDetector.shared.meetingDetectionEnabled = false
    }

    @Test func settingsRootViewIncludesMeetingsTab() {
        let state = AppState(preview: true)
        let view = SettingsRootView(state: state, updater: nil, initialTab: .meetings)
        _ = view.body
    }

    @Test func settingsTabEnumHasMeetings() {
        #expect(SettingsTab.allCases.contains(.meetings))
        #expect(SettingsTab.meetings.title == "Meetings")
        #expect(SettingsTab.meetings.systemImage == "text.bubble")
    }
}
