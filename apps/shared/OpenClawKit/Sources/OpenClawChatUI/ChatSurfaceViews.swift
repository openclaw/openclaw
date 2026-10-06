import SwiftUI

struct ChatAssistantIntroCard: View {
    let text: String
    let prompts: [OpenClawChatView.StarterPrompt]
    let onPrompt: (OpenClawChatView.StarterPrompt) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Rendered as a grey assistant bubble so the greeting reads like the
            // agent's first message, matching the in-conversation bubble style.
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

struct ChatNoticeCard: View {
    let systemImage: String
    let title: String
    let message: String
    let actionTitle: String?
    let action: (() -> Void)?

    var body: some View {
        // Native empty/error state: SwiftUI's standard ContentUnavailableView, not a custom card.
        ContentUnavailableView {
            Label(self.title, systemImage: self.systemImage)
                .font(OpenClawChatTypography.headline)
        } description: {
            Text(self.message)
                .font(OpenClawChatTypography.body)
        } actions: {
            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(OpenClawChatTypography.body(size: 15, weight: .semibold, relativeTo: .subheadline))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
        }
    }
}

struct ChatNoticeBanner: View {
    let systemImage: String
    let title: String
    let message: String
    let tint: Color
    let dismiss: () -> Void
    let refresh: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: self.systemImage)
                .font(OpenClawChatTypography.display(size: 15, weight: .semibold, relativeTo: .subheadline))
                .foregroundStyle(self.tint)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 3) {
                Text(self.title)
                    .font(OpenClawChatTypography.captionSemiBold)

                Text(self.message)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)

            Button(action: self.refresh) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Refresh")

            Button(action: self.dismiss) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Dismiss")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)))
    }
}
