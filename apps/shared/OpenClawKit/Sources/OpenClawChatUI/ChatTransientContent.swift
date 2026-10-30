import SwiftUI

struct ChatLoadingBubble: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Loading chat")
                .font(OpenClawChatTypography.captionSemiBold)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 12)
        .background(
            Capsule()
                .fill(OpenClawChatTheme.subtleCard))
        .padding(.leading, 10)
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
        if let text = self.viewModel.liveAssistantDisplayText {
            self.content(text)
        }
    }
}
