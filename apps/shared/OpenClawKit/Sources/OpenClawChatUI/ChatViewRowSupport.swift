import SwiftUI

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
