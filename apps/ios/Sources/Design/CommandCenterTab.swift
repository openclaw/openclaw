import OpenClawChatUI
import SwiftUI

struct CommandCenterTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("command.activeWork.showSessions") private var showSessionsInActiveWork: Bool = true
    @AppStorage("command.activeWork.didDefaultSessions") private var didDefaultSessionsInActiveWork = false
    @State private var activeChatSessions: [OpenClawChatSessionEntry] = []
    var openChat: () -> Void
    var openSettings: () -> Void

    private enum WorkRoute {
        case chat(String?)
        case settings
    }

    private struct WorkItem: Identifiable {
        let id: String
        let icon: String
        let title: String
        let detail: String
        let state: String
        let trailing: String
        let color: Color
        let progress: Double? = nil
        let route: WorkRoute
    }

    var body: some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        self.header
                        self.attentionCard
                        self.quickCommand
                        self.activeWork
                    }
                    .padding(.vertical, 18)
                }
                .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
            .navigationBarHidden(true)
        }
        .task(id: self.activeSessionsRefreshID) {
            await self.refreshActiveSessionsIfNeeded()
        }
        .onAppear {
            self.defaultSessionsIntoActiveWorkIfNeeded()
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            OpenClawProMark()

            VStack(alignment: .leading, spacing: 3) {
                Text("OpenClaw")
                    .font(.title3.weight(.bold))
                Text(self.gatewaySubtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            HStack(spacing: 7) {
                ProStatusDot(color: self.gatewayConnected ? OpenClawBrand.ok : .secondary)
                Text(self.gatewayConnected ? "Connected" : "Offline")
                    .font(.caption.weight(.semibold))
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var attentionCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Attention Queue")
            self.attentionCardContent
                .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var attentionCardContent: some View {
        ProCard(
            tint: self.pendingApproval == nil ? nil : OpenClawBrand.warn,
            isProminent: self.pendingApproval != nil)
        {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center, spacing: 12) {
                    ProIconBadge(
                        systemName: self
                            .pendingApproval == nil ? "checkmark.shield.fill" : "exclamationmark.triangle.fill",
                        color: self.pendingApproval == nil ? OpenClawBrand.ok : OpenClawBrand.warn)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(self.pendingApproval == nil ? "No approvals waiting" : "Approval waiting")
                                .font(.headline)
                            Spacer()
                            if self.pendingApproval != nil {
                                Text(self.appModel.pendingExecApprovalPromptResolving ? "Resolving" : "Review")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(OpenClawBrand.warn)
                            }
                        }
                        Text(self.pendingApproval?.commandPreview ?? self.pendingApproval?.commandText
                            ?? "Device and shell actions wait here until you approve them.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Image(systemName: self.pendingApproval == nil ? "checkmark" : "bell.badge")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }

                if let pendingApproval {
                    HStack(spacing: 8) {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-once") }
                        } label: {
                            Label("Allow", systemImage: "checkmark")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)

                        if pendingApproval.allowsAllowAlways {
                            Button {
                                Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-always") }
                            } label: {
                                Label("Always", systemImage: "checkmark.shield")
                            }
                            .buttonStyle(.bordered)
                            .disabled(self.appModel.pendingExecApprovalPromptResolving)
                        }

                        Button(role: .destructive) {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "deny") }
                        } label: {
                            Label("Deny", systemImage: "xmark")
                        }
                        .buttonStyle(.bordered)
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)

                        Spacer(minLength: 0)
                    }
                    .controlSize(.small)
                }
            }
        }
    }

    private var quickCommand: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Start Work")
            Button(action: self.openChat) {
                HStack(spacing: 11) {
                    Image(systemName: "bubble.left.and.text.bubble.right.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(OpenClawBrand.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Open Chat")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                        Text("Ask OpenClaw or start code work")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "arrow.right")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(OpenClawBrand.accentHot, in: Circle())
                }
                .padding(.leading, 14)
                .padding(.trailing, 6)
                .frame(height: 50)
                .background(.regularMaterial, in: Capsule())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var activeWork: some View {
        VStack(alignment: .leading, spacing: 8) {
            self.activeWorkHeader
            ProCard(padding: 0) {
                let items = self.activeWorkItems
                if items.isEmpty {
                    self.emptyActiveWorkState
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            Button {
                                self.open(item.route)
                            } label: {
                                ProWorkRow(
                                    icon: item.icon,
                                    title: item.title,
                                    detail: item.detail,
                                    state: item.state,
                                    trailing: item.trailing,
                                    color: item.color,
                                    progress: item.progress)
                                    .padding(.horizontal, 14)
                            }
                            .buttonStyle(.plain)

                            if index < items.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var activeWorkHeader: some View {
        HStack(spacing: 12) {
            Text("Active Work")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Spacer(minLength: 8)
            Toggle("Sessions", isOn: self.$showSessionsInActiveWork)
                .font(.caption.weight(.medium))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .fixedSize()
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var activeSessionsRefreshID: String {
        [
            self.showSessionsInActiveWork ? "sessions" : "no-sessions",
            self.appModel.isOperatorGatewayConnected ? "connected" : "offline",
            self.appModel.chatSessionKey,
            self.scenePhase == .active ? "active" : "inactive",
        ].joined(separator: ":")
    }

    private var activeWorkItems: [WorkItem] {
        var items: [WorkItem] = []

        if self.appModel.talkMode.isListening || self.appModel.talkMode.isSpeaking {
            items.append(WorkItem(
                id: "talk-session",
                icon: "waveform",
                title: "Talk session",
                detail: self.appModel.talkMode.statusText,
                state: self.appModel.talkMode.isListening ? "listening" : "speaking",
                trailing: "voice",
                color: OpenClawBrand.ok,
                route: .settings))
        }

        if self.appModel.screenRecordActive {
            items.append(WorkItem(
                id: "screen-share",
                icon: "display",
                title: "Screen share",
                detail: "Screen capture is active",
                state: "running",
                trailing: "device",
                color: OpenClawBrand.ok,
                route: .settings))
        } else if let cameraText = appModel.cameraHUDText, !cameraText.isEmpty {
            items.append(WorkItem(
                id: "camera-event",
                icon: "camera.fill",
                title: "Camera",
                detail: cameraText,
                state: "recent",
                trailing: "device",
                color: OpenClawBrand.ok,
                route: .settings))
        }

        if self.showSessionsInActiveWork {
            items.append(contentsOf: self.sessionWorkItems)
        }

        return Array(items.prefix(4))
    }

    private var sessionWorkItems: [WorkItem] {
        let currentSessionKey = self.appModel.chatSessionKey
        return self.activeChatSessions
            .filter { !Self.isHiddenInternalSession($0.key) }
            .prefix(4)
            .map { session in
                let isCurrent = session.key == currentSessionKey
                return WorkItem(
                    id: "chat-session-\(session.key)",
                    icon: isCurrent ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.fill",
                    title: Self.sessionTitle(session),
                    detail: Self.sessionDetail(session),
                    state: isCurrent ? "current" : "recent",
                    trailing: "chat",
                    color: isCurrent ? OpenClawBrand.accent : OpenClawBrand.ok,
                    route: .chat(session.key))
            }
    }

    private var emptyActiveWorkState: some View {
        HStack(spacing: 11) {
            ProIconBadge(systemName: "checkmark.circle", color: .secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("No active work")
                    .font(.subheadline.weight(.semibold))
                Text("Live talk, screen share, and device capture activity will appear here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
        }
    }

    private func open(_ route: WorkRoute) {
        switch route {
        case let .chat(sessionKey):
            self.appModel.openChat(sessionKey: sessionKey)
            self.openChat()
        case .settings:
            self.openSettings()
        }
    }

    private func refreshActiveSessionsIfNeeded() async {
        guard self.scenePhase == .active else { return }
        guard self.showSessionsInActiveWork else {
            if !self.activeChatSessions.isEmpty {
                self.activeChatSessions = []
            }
            return
        }
        guard self.appModel.isOperatorGatewayConnected else {
            if !self.activeChatSessions.isEmpty {
                self.activeChatSessions = []
            }
            return
        }

        do {
            let transport = IOSGatewayChatTransport(gateway: self.appModel.operatorSession)
            let response = try await transport.listSessions(limit: 12)
            self.activeChatSessions = Self.sessionChoices(
                response.sessions,
                currentSessionKey: self.appModel.chatSessionKey)
        } catch {
            self.activeChatSessions = []
        }
    }

    private func defaultSessionsIntoActiveWorkIfNeeded() {
        guard !self.didDefaultSessionsInActiveWork else { return }
        self.showSessionsInActiveWork = true
        self.didDefaultSessionsInActiveWork = true
    }

    private static func sessionChoices(
        _ sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String) -> [OpenClawChatSessionEntry]
    {
        let sorted = sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
        var result: [OpenClawChatSessionEntry] = []
        var included = Set<String>()

        if let current = sorted.first(where: { $0.key == currentSessionKey }) {
            result.append(current)
            included.insert(current.key)
        }

        for session in sorted {
            guard !included.contains(session.key) else { continue }
            guard !Self.isHiddenInternalSession(session.key) else { continue }
            result.append(session)
            included.insert(session.key)
            if result.count >= 4 { break }
        }

        return result
    }

    private static func sessionTitle(_ session: OpenClawChatSessionEntry) -> String {
        let displayName = session.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let displayName, !displayName.isEmpty {
            return displayName
        }
        let subject = session.subject?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let subject, !subject.isEmpty {
            return subject
        }
        return session.key
    }

    private static func sessionDetail(_ session: OpenClawChatSessionEntry) -> String {
        if let updatedAt = session.updatedAt, updatedAt > 0 {
            return Date(timeIntervalSince1970: updatedAt / 1000).formatted(
                date: .abbreviated,
                time: .shortened)
        }
        return session.key
    }

    private static func isHiddenInternalSession(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed == "onboarding" || trimmed.hasSuffix(":onboarding")
    }

    private var gatewaySubtitle: String {
        if let server = normalized(appModel.gatewayServerName) {
            return "\(self.appModel.activeAgentName) on \(server)"
        }
        if let address = normalized(appModel.gatewayRemoteAddress) {
            return "\(self.appModel.activeAgentName) via \(address)"
        }
        return self.appModel.gatewayDisplayStatusText
    }

    private var pendingApproval: NodeAppModel.ExecApprovalPrompt? {
        self.appModel.pendingExecApprovalPrompt
    }

    private func normalized(_ value: String?) -> String? {
        Self.normalized(value)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
