import SwiftUI

struct WatchHomeView: View {
    @Bindable var store: WatchInboxStore
    var onAction: ((WatchPromptAction) -> Void)?

    private func role(for action: WatchPromptAction) -> ButtonRole? {
        switch action.style?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "destructive": .destructive
        case "cancel": .cancel
        default: nil
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: WatchDesignTokens.spacingMD) {
                WatchConnectionBanner(isConnected: store.isReachable)

                if store.hasContent {
                    messageContent
                } else {
                    WatchEmptyStateView()
                }
            }
            .padding(.horizontal, WatchDesignTokens.spacingSM)
            .animation(WatchDesignTokens.spring, value: store.hasContent)
        }
    }

    @ViewBuilder
    private var messageContent: some View {
        WatchMessageCard(
            title: store.title,
            body: store.body,
            details: store.details,
            risk: store.risk,
            isExpired: store.isExpired)

        if !store.actions.isEmpty {
            actionButtons
        }

        if let status = store.replyStatusText, !status.isEmpty {
            Text(status)
                .font(WatchDesignTokens.fontCaption)
                .foregroundStyle(.secondary)
        }

        if let updatedAt = store.updatedAt {
            Text("Updated \(updatedAt.formatted(date: .omitted, time: .shortened))")
                .font(WatchDesignTokens.fontCaption)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        ForEach(store.actions) { action in
            WatchActionButton(
                label: action.label,
                role: role(for: action),
                isLoading: store.isReplySending,
                isDisabled: store.isExpired)
            {
                onAction?(action)
            }
        }
    }
}
