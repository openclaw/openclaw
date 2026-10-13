import OpenClawKit

struct ScreenRecordingPermissionState {
    // macOS exposes a binary check; after our request, missing access needs Settings.
    var requestAttempted = false
    var needsRestart = false

    func missingState(granted: Bool) -> OpenClawPermissionState? {
        if self.needsRestart { return .restartRequired }
        return granted ? nil : self.requestAttempted ? .denied : .notDetermined
    }
}
