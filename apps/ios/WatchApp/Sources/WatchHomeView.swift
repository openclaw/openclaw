import SwiftUI

struct WatchHomeView: View {
    @Bindable var store: WatchInboxStore
    var onAction: ((WatchPromptAction) -> Void)?

    @State private var lastRisk: String?

    private func role(for action: WatchPromptAction) -> ButtonRole? {
        switch action.style?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "destructive": .destructive
        case "cancel": .cancel
        default: nil
        }
    }

    private var hapticFeedback: SensoryFeedback {
        switch lastRisk?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "high": .error
        case "medium": .warning
        default: .success
        }
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(spacing: WatchDesignTokens.spacingMD) {
                if store.hasContent {
                    messageContent
                } else {
                    WatchEmptyStateView()
                }
            }
            .padding(.horizontal, WatchDesignTokens.spacingSM)
            .animation(WatchDesignTokens.spring, value: store.hasContent)
        }
        .defaultScrollAnchor(.top)
        .safeAreaInset(edge: .top) {
            WatchConnectionBanner(isConnected: store.isReachable)
                .padding(.horizontal, WatchDesignTokens.spacingSM)
        }
        .sensoryFeedback(hapticFeedback, trigger: store.updatedAt) { oldValue, newValue in
            // Only trigger when a new message arrives (updatedAt changes)
            oldValue != newValue && newValue != nil
        }
        .onChange(of: store.risk) { _, newRisk in
            lastRisk = newRisk
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
        ForEach(Array(store.actions.enumerated()), id: \.element.id) { index, action in
            WatchActionButton(
                label: action.label,
                role: role(for: action),
                isLoading: store.isReplySending,
                isDisabled: store.isExpired)
            {
                onAction?(action)
            }
            // Double Tap gesture triggers the first action button
            .handGestureShortcut(index == 0 ? .primaryAction : .never)
        }
    }
}
