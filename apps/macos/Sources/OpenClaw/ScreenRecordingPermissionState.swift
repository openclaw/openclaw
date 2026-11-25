import OpenClawKit

@MainActor
final class ScreenRecordingPermissionState {
    // macOS exposes a binary check; after our request, missing access needs Settings.
    var requestAttempted = false
    var needsRestart = false

    func ensure(
        interactive: Bool,
        isCurrent: () -> Bool,
        check: (_ forceProbe: Bool) async -> Bool,
        request: () -> Void,
        openSettings: () -> Void) async -> Bool
    {
        let granted = await check(false)
        guard !Task.isCancelled, isCurrent() else { return false }
        guard interactive, !granted else { return granted }
        if self.requestAttempted {
            openSettings()
        } else {
            self.requestAttempted = true
            request()
        }
        return await check(true)
    }

    func missingState(granted: Bool) -> OpenClawPermissionState? {
        if self.needsRestart { return .restartRequired }
        return granted ? nil : self.requestAttempted ? .denied : .notDetermined
    }
}
