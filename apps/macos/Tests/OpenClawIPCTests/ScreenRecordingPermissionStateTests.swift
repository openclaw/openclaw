import OpenClawKit
import Testing
@testable import OpenClaw

struct ScreenRecordingPermissionStateTests {
    @Test func `denied request offers settings instead of another prompt`() {
        var state = ScreenRecordingPermissionState()
        #expect(state.missingState(granted: false) == .notDetermined)
        state.requestAttempted = true
        #expect(state.missingState(granted: false) == .denied)
        #expect(state.missingState(granted: true) == nil)
        state.needsRestart = true
        #expect(state.missingState(granted: true) == .restartRequired)
    }
}
