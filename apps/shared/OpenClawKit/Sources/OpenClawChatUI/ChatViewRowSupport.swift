import SwiftUI

extension OpenClawChatView {
    enum Layout {
        static let newTurnAnchor = UnitPoint(x: 0.5, y: ChatReadingPolicy.turnAnchor)
        static let liveEdgeThreshold: CGFloat = 48
        #if os(macOS)
        static let outerPaddingVertical: CGFloat = 0
        static let swarmPaddingVertical: CGFloat = 8
        static let stackSpacing: CGFloat = 0
        static let messageSpacing: CGFloat = 6
        static let messageListPaddingTop: CGFloat = 12
        static let messageListPaddingBottom: CGFloat = 16
        #else
        static let outerPaddingVertical: CGFloat = 6
        static let swarmPaddingVertical: CGFloat = 0
        static let stackSpacing: CGFloat = 6
        static let messageSpacing: CGFloat = 12
        static let messageListPaddingTop: CGFloat = 10
        static let messageListPaddingBottom: CGFloat = 6
        #endif
    }
}

/// Row inputs read from the view model once per transcript pass, not once per row.
struct ChatRowPassInputs {
    let contextWindowTokens: Int?
    /// Each row looks up its own run instead of filtering every live call.
    let liveToolCalls: [String: [OpenClawChatPendingToolCall]]

    static func liveToolCallsByRun(_ calls: [OpenClawChatPendingToolCall]) -> [String: [OpenClawChatPendingToolCall]] {
        var byRun: [String: [OpenClawChatPendingToolCall]] = [:]
        for call in calls {
            guard let runID = call.runID else { continue }
            byRun[runID, default: []].append(call)
        }
        return byRun
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
