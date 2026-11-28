import Foundation

/// A chat setting change that failed. It is the outcome of something the person just did, so it answers
/// in the app's toast, never in the status strip.
extension OpenClawChatViewModel {
    /// The permissions sheet and the "+" sheet show a failed change in their own footers while open; the
    /// toast waits for neither and doesn't repeat them.
    nonisolated static let permissionsSheetSurface = "permissions-sheet"
    nonisolated static let addSheetSurface = "add-sheet"

    /// Without a toast presenter (the Mac), the chat's error line keeps the message.
    func postSettingChangeFailure(_ patch: OpenClawChatSessionSettingsPatch, otherwise: () -> Void) {
        #if os(iOS)
        let text: String
        let retry: @MainActor () -> Void
        if let mode = patch.permissionMode {
            text = String(localized: "Couldn’t change access.")
            retry = { [weak self] in self?.selectComposerPermissionMode(mode) }
        } else if let webSearch = self.webSearchChange(in: patch) {
            text = webSearch
                ? String(localized: "Couldn’t turn on Web search.")
                : String(localized: "Couldn’t turn off Web search.")
            retry = { [weak self] in
                guard let self, self.composerWebSearchEnabled != webSearch else { return }
                self.toggleComposerWebSearch()
            }
        } else if case let .some(wanted) = patch.toolOverrides {
            let wanted = wanted ?? OpenClawChatSessionToolOverrides()
            text = wanted.skills != self.composerToolOverrides.skills
                ? String(localized: "Couldn’t update skills.")
                : String(localized: "Couldn’t update connectors.")
            // Sending the same change again is the retry; a later change from the sheet replaces it.
            retry = { [weak self] in self?.patchComposerToolOverrides(wanted) }
        } else {
            otherwise()
            return
        }
        guard !self.statusStrip.isSurfaceOpen(Self.permissionsSheetSurface),
              !self.statusStrip.isSurfaceOpen(Self.addSheetSurface)
        else { return }
        if let toasts = self.statusStrip.toasts {
            toasts.post(.failure(text, retry: retry))
        } else {
            otherwise()
        }
        #else
        otherwise()
        #endif
    }

    /// The Web search state a tool-override patch asks for, when Web search is all it changes.
    private func webSearchChange(in patch: OpenClawChatSessionSettingsPatch) -> Bool? {
        guard case let .some(overrides) = patch.toolOverrides else { return nil }
        let current = self.composerToolOverrides
        var others = overrides ?? OpenClawChatSessionToolOverrides()
        others.webSearch = current.webSearch
        let wanted = overrides?.webSearch ?? self.composerCapabilityCatalog.webSearchBaseEnabled
        guard others == current, wanted != self.composerWebSearchEnabled else { return nil }
        return wanted
    }
}
