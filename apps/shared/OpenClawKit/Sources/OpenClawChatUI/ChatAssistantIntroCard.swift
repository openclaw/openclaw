import SwiftUI

struct ChatAssistantIntroCard: View {
    let text: String
    let prompts: [OpenClawChatView.StarterPrompt]
    let onPrompt: (OpenClawChatView.StarterPrompt) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(self.text)
                .font(OpenClawChatTypography.body)
                .foregroundStyle(OpenClawChatTheme.assistantText)
                .multilineTextAlignment(.leading)
                .padding(.vertical, 10)
                .padding(.horizontal, 14)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(OpenClawChatTheme.assistantBubble))

            ForEach(self.prompts) { prompt in
                Button {
                    self.onPrompt(prompt)
                } label: {
                    HStack(spacing: 8) {
                        Text(prompt.title)
                            .font(OpenClawChatTypography.body(size: 15, weight: .semibold, relativeTo: .callout))
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.up.right")
                            .font(OpenClawChatTypography.captionSemiBold)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(OpenClawChatTheme.subtleCard))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat-starter-\(prompt.id)")
            }
        }
        .frame(maxWidth: 340, alignment: .leading)
        .padding(.top, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
