import SwiftUI

/// Row inputs read from the view model once per transcript pass, not once per row.
struct ChatRowPassInputs {
    let contextWindowTokens: Int?
    /// Each row looks up its own run instead of filtering every live call.
    let liveToolCalls: [String: [OpenClawChatPendingToolCall]]
    /// Set only while the agent row shows under the latest reply alone.
    var latestReplyID: UUID?

    static func liveToolCallsByRun(_ calls: [OpenClawChatPendingToolCall]) -> [String: [OpenClawChatPendingToolCall]] {
        var byRun: [String: [OpenClawChatPendingToolCall]] = [:]
        for call in calls {
            guard let runID = call.runID else { continue }
            byRun[runID, default: []].append(call)
        }
        return byRun
    }
}

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

/// Keep frequently changing run telemetry outside the transcript's observation scope.
struct ChatRunStatusContent<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        self.content()
    }
}

/// Owns the observation of the paced words; its parent only observes live-content shape.
struct ChatLiveAssistantText<Content: View>: View {
    let viewModel: OpenClawChatViewModel
    @ViewBuilder var content: (String) -> Content

    var body: some View {
        if let text = self.viewModel.displayedStreamingAssistantText {
            self.content(text)
        }
    }
}
