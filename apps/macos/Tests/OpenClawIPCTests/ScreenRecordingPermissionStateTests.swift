import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct ScreenRecordingPermissionStateTests {
    @Test(arguments: [(false, false), (false, true), (true, true)])
    func `checks without a recovery action probe exactly once`(interactive: Bool, granted: Bool) async {
        let state = ScreenRecordingPermissionState()
        var probes: [Bool] = []
        let result = await state.ensure(
            interactive: interactive,
            isCurrent: { true },
            check: { probes.append($0)
                return granted
            },
            request: { Issue.record("No permission request expected") },
            openSettings: { Issue.record("No Settings action expected") })

        #expect(result == granted)
        #expect(probes == [false])
    }

    @Test func `denial refreshes access then the next attempt opens Settings`() async {
        let state = ScreenRecordingPermissionState()
        var probes: [Bool] = []
        var requests = 0
        var settingsOpened = 0
        for _ in 0..<2 {
            let granted = await state.ensure(
                interactive: true,
                isCurrent: { true },
                check: { probes.append($0)
                    return false
                },
                request: { requests += 1 },
                openSettings: { settingsOpened += 1 })
            #expect(!granted)
            #expect(state.missingState(granted: granted) == .denied)
        }
        #expect(probes == [false, true, false, true])
        #expect(requests == 1)
        #expect(settingsOpened == 1)
    }

    @Test func `denied request offers settings instead of another prompt`() {
        let state = ScreenRecordingPermissionState()
        #expect(state.missingState(granted: false) == .notDetermined)
        state.requestAttempted = true
        #expect(state.missingState(granted: false) == .denied)
        #expect(state.missingState(granted: true) == nil)
        state.needsRestart = true
        #expect(state.missingState(granted: true) == .restartRequired)
    }
}
