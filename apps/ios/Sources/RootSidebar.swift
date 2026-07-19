import OpenClawChatUI
import SwiftUI

struct RootSidebar: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.displayScale) private var displayScale
    @Bindable var model: RootSidebarModel
    @State private var searchText = ""

    let selectedDestination: RootTabs.SidebarDestination
    let isDrawerLayout: Bool
    let selectDestination: (RootTabs.SidebarDestination) -> Void
    let selectSettingsRoute: (SettingsRoute) -> Void
    let hideSidebar: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            self.identityHeader
            self.primaryActions
            self.searchField
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    self.sessionsSection
                    self.pagesSection
                    self.attentionSection
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 12)
            }
            self.footer
        }
        .foregroundStyle(OpenClawSidebarPalette.text)
        .background(OpenClawSidebarPalette.background)
        .environment(\.colorScheme, .dark)
        .task(id: self.refreshID) {
            guard self.scenePhase == .active else { return }
            await self.model.refresh(appModel: self.appModel)
        }
    }

    private var refreshID: String {
        "\(self.appModel.chatViewModelIdentityID):\(self.scenePhase == .active)"
    }

    private var identityHeader: some View {
        HStack(spacing: 10) {
            OpenClawProMark(size: 30, shadowRadius: 3)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(String(localized: "OpenClaw"))
                    .font(OpenClawType.headline)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .lineLimit(1)

                HStack(spacing: 5) {
                    Circle()
                        .fill(self.gatewayStatusColor)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                    Text(self.gatewayStatusTitle)
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            if self.isDrawerLayout {
                Button(action: self.hideSidebar) {
                    Image(systemName: "xmark")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(OpenClawSidebarPalette.accent)
                .accessibilityLabel(String(localized: "Hide Sidebar"))
                .accessibilityIdentifier(RootTabs.sidebarHideButtonAccessibilityIdentifier)
            }
        }
        .padding(.leading, 18)
        .padding(.trailing, 10)
        .padding(.vertical, 10)
        .background(OpenClawSidebarPalette.background)
        .overlay(alignment: .bottom) { self.separator }
    }

    private var primaryActions: some View {
        Button {
            self.appModel.requestNewChat()
            self.selectDestination(.chat)
        } label: {
            Label {
                Text(String(localized: "New Chat"))
                    .font(OpenClawType.subheadSemiBold)
            } icon: {
                Image(systemName: "plus.bubble")
                    .font(OpenClawType.subheadSemiBold)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.textStrong)
        .background(OpenClawSidebarPalette.elevated, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .disabled(!self.appModel.isOperatorGatewayConnected)
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(OpenClawSidebarPalette.muted)
                .accessibilityHidden(true)
            ZStack(alignment: .leading) {
                if self.searchText.isEmpty {
                    Text(String(localized: "Search sessions"))
                        .font(OpenClawType.subhead)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .accessibilityHidden(true)
                }
                TextField("", text: self.$searchText)
                    .font(OpenClawType.subhead)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel(String(localized: "Search sessions"))
            }
            if !self.searchText.isEmpty {
                Button {
                    self.searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(OpenClawType.subhead)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "Clear session search"))
            }
        }
        .frame(minHeight: 44)
        .padding(.horizontal, 12)
        .background(OpenClawSidebarPalette.elevated, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
    }

    @ViewBuilder
    private var sessionsSection: some View {
        let sections = self.visibleSessionSections
        VStack(alignment: .leading, spacing: 6) {
            self.sectionTitle(String(localized: "Sessions"))
            if let sessionErrorText = self.model.sessionErrorText {
                Text(verbatim: sessionErrorText)
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(OpenClawBrand.warn)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
            }
            if self.model.isRefreshing, self.model.sessions.isEmpty {
                HStack(spacing: 9) {
                    ProgressView().controlSize(.small)
                    Text(String(localized: "Loading sessions"))
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                }
                .frame(minHeight: 44)
                .padding(.horizontal, 10)
            } else if sections.isEmpty {
                Text(String(localized: "No recent sessions"))
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 10)
            } else {
                ForEach(sections) { section in
                    if let title = section.title {
                        Text(title)
                            .font(OpenClawType.captionSemiBold)
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                            .padding(.horizontal, 10)
                            .padding(.top, 4)
                    }
                    ForEach(self.sessionNodes(for: section)) { node in
                        self.sessionButton(node)
                    }
                }
            }

            Button {
                self.selectDestination(.sessions)
            } label: {
                Label {
                    Text(String(localized: "All Sessions…"))
                        .font(OpenClawType.subheadSemiBold)
                } icon: {
                    Image(systemName: "rectangle.stack")
                        .font(OpenClawType.subheadSemiBold)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(OpenClawSidebarPalette.accent)
        }
    }

    private var pagesSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            self.sectionTitle(String(localized: "Pages"))
            ForEach(RootTabs.sidebarDestinations) { destination in
                self.destinationButton(destination)
            }
        }
    }

    @ViewBuilder
    private var attentionSection: some View {
        let approvalCount = self.appModel.pendingExecApprovalCount
        if approvalCount > 0 || self.model.hasCronAttention {
            VStack(alignment: .leading, spacing: 2) {
                self.sectionTitle(String(localized: "Attention"))
                if approvalCount > 0 {
                    self.attentionButton(
                        title: String(localized: "Pending approvals"),
                        value: approvalCount.formatted(),
                        systemImage: "checkmark.shield",
                        color: OpenClawBrand.warn)
                    {
                        self.selectSettingsRoute(.approvals)
                    }
                }
                if self.model.hasCronAttention {
                    self.attentionButton(
                        title: String(localized: "Automation issues"),
                        value: (self.model.failedCronJobCount + self.model.overdueCronJobCount).formatted(),
                        systemImage: "clock.badge.exclamationmark",
                        color: OpenClawBrand.warn)
                    {
                        self.selectDestination(.cron)
                    }
                }
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 2) {
            self.separator
            self.footerButton(
                title: self.gatewayName,
                systemImage: "network",
                statusColor: self.gatewayStatusColor)
            {
                self.selectDestination(.gateway)
            }
            self.footerButton(
                title: String(localized: "Settings"),
                systemImage: "gearshape",
                statusColor: nil)
            {
                self.selectDestination(.settings)
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        .background(OpenClawSidebarPalette.background)
    }

    private var visibleSessionSections: [ChatSessionSidebarModel.Section] {
        self.model.sections(
            query: self.searchText,
            currentSessionKey: self.appModel.chatSessionKey,
            mainSessionKey: self.appModel.defaultChatSessionKey,
            activeAgentID: self.appModel.chatAgentId)
    }

    private var sessionCategories: [String] {
        CommandSessionGrouping.categories(from: self.model.sessions, knownGroups: SessionGroupStore.load())
    }

    private func flattened(_ nodes: [ChatSessionSidebarModel.Node]) -> [ChatSessionSidebarModel.Node] {
        nodes.flatMap { [$0] + self.flattened($0.children) }
    }

    private func sessionNodes(for section: ChatSessionSidebarModel.Section) -> [ChatSessionSidebarModel.Node] {
        let nodes = self.flattened(section.nodes)
        return section.id == "recent" ? Array(nodes.prefix(20)) : nodes
    }

    private func sessionButton(_ node: ChatSessionSidebarModel.Node) -> some View {
        let session = node.session
        let isSelected = session.key == self.appModel.chatSessionKey
        return Button {
            self.appModel.openChat(sessionKey: session.key, unread: session.unread == true)
            self.selectDestination(.chat)
        } label: {
            HStack(spacing: 9) {
                ZStack {
                    if node.badges.runningCount > 0 {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(OpenClawSidebarPalette.accent)
                    } else {
                        Image(systemName: "bubble.left")
                            .font(OpenClawType.captionSemiBold)
                            .foregroundStyle(isSelected
                                ? OpenClawSidebarPalette.accent
                                : OpenClawSidebarPalette.muted)
                    }
                }
                .frame(width: 18)

                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: CommandCenterTab.sessionTitle(session))
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(isSelected
                            ? OpenClawSidebarPalette.accent
                            : OpenClawSidebarPalette.textStrong)
                        .lineLimit(1)
                    Text(verbatim: CommandCenterTab.sessionDetail(session))
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)
                if session.unread == true {
                    Circle()
                        .fill(OpenClawSidebarPalette.accent)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                }
                if session.pinned == true {
                    Image(systemName: "pin.fill")
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(OpenClawSidebarPalette.accent)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .commandSessionActions(
            session: session,
            categories: self.sessionCategories,
            isEnabled: self.appModel.isOperatorGatewayConnected,
            actions: CommandSessionActions(
                rename: { self.patchSession(session, label: .some($0)) },
                moveToGroup: { self.patchSession(session, category: .some($0)) },
                togglePinned: { self.patchSession(session, pinned: session.pinned != true) },
                toggleUnread: { self.patchSession(session, unread: session.unread != true) },
                fork: { self.forkSession(session) },
                toggleArchived: { self.patchSession(session, archived: true) },
                delete: { self.deleteSession(session) }))
        .accessibilityValue(session.unread == true ? String(localized: "Unread") : "")
    }

    private func destinationButton(_ destination: RootTabs.SidebarDestination) -> some View {
        let isSelected = destination == self.selectedDestination
        return Button {
            self.selectDestination(destination)
        } label: {
            Label {
                Text(destination.sidebarTitle)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
            } icon: {
                Image(systemName: destination.systemImage)
                    .font(OpenClawType.subheadSemiBold)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? OpenClawSidebarPalette.accent : OpenClawSidebarPalette.text)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
    }

    private func attentionButton(
        title: String,
        value: String,
        systemImage: String,
        color: Color,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: systemImage)
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(color)
                    .frame(width: 18)
                Text(verbatim: title)
                    .font(OpenClawType.subheadSemiBold)
                Spacer(minLength: 6)
                Text(verbatim: value)
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(color)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.text)
    }

    private func footerButton(
        title: String,
        systemImage: String,
        statusColor: Color?,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 9) {
                if let statusColor {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                        .frame(width: 18)
                } else {
                    Image(systemName: systemImage)
                        .font(OpenClawType.subheadSemiBold)
                        .frame(width: 18)
                }
                Text(verbatim: title)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Spacer(minLength: 4)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawSidebarPalette.text)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(verbatim: title.uppercased())
            .font(OpenClawType.caption2Bold)
            .foregroundStyle(OpenClawSidebarPalette.muted)
            .tracking(0.5)
            .padding(.horizontal, 10)
    }

    private var separator: some View {
        Rectangle()
            .fill(OpenClawSidebarPalette.hairline)
            .frame(height: 1 / self.displayScale)
    }

    private var gatewayName: String {
        Self.gatewayName(
            serverName: self.appModel.gatewayServerName,
            remoteAddress: self.appModel.gatewayRemoteAddress)
    }

    static func gatewayName(serverName: String?, remoteAddress: String?) -> String {
        for candidate in [serverName, remoteAddress] {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty { return trimmed }
        }
        return String(localized: "Connection")
    }

    private var gatewayStatusTitle: String {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected: String(localized: "Online")
        case .connecting: String(localized: "Connecting")
        case .error: String(localized: "Needs attention")
        case .disconnected: String(localized: "Offline")
        }
    }

    private var gatewayStatusColor: Color {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected: OpenClawBrand.ok
        case .connecting: OpenClawBrand.accent
        case .error: OpenClawBrand.warn
        case .disconnected: OpenClawSidebarPalette.muted
        }
    }

    private func patchSession(
        _ session: OpenClawChatSessionEntry,
        label: String?? = nil,
        category: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil)
    {
        Task {
            do {
                try await self.appModel.makeChatTransport().patchSession(
                    key: session.key,
                    label: label,
                    category: category,
                    pinned: pinned,
                    archived: archived,
                    unread: unread)
                if archived == true, session.key == self.appModel.chatSessionKey {
                    self.appModel.focusChatSession(nil)
                }
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                self.model.reportSessionError(error)
            }
        }
    }

    private func deleteSession(_ session: OpenClawChatSessionEntry) {
        Task {
            do {
                try await self.appModel.makeChatTransport().deleteSession(key: session.key)
                if session.key == self.appModel.chatSessionKey {
                    self.appModel.focusChatSession(nil)
                }
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                self.model.reportSessionError(error)
            }
        }
    }

    private func forkSession(_ session: OpenClawChatSessionEntry) {
        Task {
            do {
                let key = try await self.appModel.makeChatTransport().forkSession(parentKey: session.key)
                self.appModel.openChat(sessionKey: key)
                self.selectDestination(.chat)
                await self.model.refreshSessions(appModel: self.appModel)
            } catch {
                self.model.reportSessionError(error)
            }
        }
    }
}
