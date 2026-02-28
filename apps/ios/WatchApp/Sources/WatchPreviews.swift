import SwiftUI

// MARK: - WatchHomeView Previews

#Preview("Home: Connected with Message") {
    @Previewable @State var store = WatchInboxStore.previewStore(
        title: "Approve SSH key",
        body: "Agent requests access to deploy key for production server.",
        risk: "high",
        actions: [
            WatchPromptAction(id: "approve", label: "Approve", style: nil),
            WatchPromptAction(id: "deny", label: "Deny", style: "destructive"),
        ],
        isReachable: true)

    NavigationStack {
        WatchHomeView(store: store) { _ in }
            .navigationTitle("OpenClaw")
    }
}

#Preview("Home: Disconnected Empty") {
    @Previewable @State var store = WatchInboxStore.previewStore(isReachable: false)

    NavigationStack {
        WatchHomeView(store: store) { _ in }
            .navigationTitle("OpenClaw")
    }
}

// MARK: - WatchMessageCard Previews

#Preview("Card: Normal") {
    WatchMessageCard(
        title: "Daily Summary",
        body: "3 tasks completed, 1 pending review.")
}

#Preview("Card: High Risk") {
    WatchMessageCard(
        title: "Deploy to Production",
        body: "Merge main into release branch and trigger CI pipeline.",
        risk: "high")
}

#Preview("Card: Expired") {
    WatchMessageCard(
        title: "Session Token Refresh",
        body: "Token expired 5 minutes ago.",
        details: "Session: abc-123",
        isExpired: true)
}

// MARK: - WatchActionButton Previews

#Preview("Button: Normal") {
    WatchActionButton(label: "Approve", action: {})
}

#Preview("Button: Loading") {
    WatchActionButton(label: "Approve", isLoading: true, action: {})
}

#Preview("Button: Disabled") {
    WatchActionButton(label: "Approve", isDisabled: true, action: {})
}

#Preview("Button: Destructive") {
    WatchActionButton(label: "Deny", role: .destructive, action: {})
}

// MARK: - WatchConnectionBanner Previews

#Preview("Banner: Connected") {
    WatchConnectionBanner(isConnected: true)
}

#Preview("Banner: Disconnected") {
    WatchConnectionBanner(isConnected: false)
}

// MARK: - WatchRiskBadge Previews

#Preview("Risk: High") {
    WatchRiskBadge(risk: "high")
}

#Preview("Risk: Medium") {
    WatchRiskBadge(risk: "medium")
}

#Preview("Risk: Low") {
    WatchRiskBadge(risk: "low")
}

// MARK: - WatchEmptyStateView Preview

#Preview("Empty State") {
    WatchEmptyStateView()
}

// MARK: - Preview Helpers

extension WatchInboxStore {
    /// Creates a store pre-populated with sample data for SwiftUI previews.
    static func previewStore(
        title: String = "OpenClaw",
        body: String = "Waiting for messages from your iPhone.",
        risk: String? = nil,
        actions: [WatchPromptAction] = [],
        isReachable: Bool = true
    ) -> WatchInboxStore {
        let store = WatchInboxStore(defaults: .standard)
        store.title = title
        store.body = body
        store.risk = risk
        store.actions = actions
        store.isReachable = isReachable
        if title != "OpenClaw" || body != "Waiting for messages from your iPhone." {
            store.updatedAt = Date()
        }
        return store
    }
}
