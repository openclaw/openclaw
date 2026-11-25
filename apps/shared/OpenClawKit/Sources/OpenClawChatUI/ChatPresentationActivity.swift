import SwiftUI

/// Applies drawer and scene visibility to the model. It reads `openClawChatIsObscured` itself, so
/// opening or closing the sidebar drawer updates stream pacing and composer presentation without
/// re-running the transcript.
struct ChatPresentationActivity: ViewModifier {
    let viewModel: OpenClawChatViewModel
    let isOnScreen: Bool
    @Environment(\.openClawChatIsObscured) private var isObscured
    #if os(macOS)
    @Environment(\.appearsActive) private var appearsActive
    #else
    @Environment(\.scenePhase) private var scenePhase
    #endif

    /// A rejected message returns to the composer only while the user can see it.
    private var isComposerPresentationActive: Bool {
        #if os(macOS)
        self.isOnScreen && self.appearsActive && !self.isObscured
        #else
        self.isOnScreen && self.scenePhase == .active && !self.isObscured
        #endif
    }

    func body(content: Content) -> some View {
        content
            .onChange(of: ObjectIdentifier(self.viewModel)) { _, _ in
                self.viewModel.streamPacing.interval = self.isObscured ? 0.5 : 0.15
                self.viewModel.setComposerPresentationActive(self.isComposerPresentationActive)
            }
            .onChange(of: self.isComposerPresentationActive, initial: true) { _, active in
                self.viewModel.setComposerPresentationActive(active)
            }
            .onChange(of: self.isObscured, initial: true) { _, obscured in
                self.viewModel.streamPacing.interval = obscured ? 0.5 : 0.15
            }
    }
}
