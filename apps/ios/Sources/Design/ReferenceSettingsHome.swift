import SwiftUI

struct ReferenceSettingsHome: View {
    @Environment(NodeAppModel.self) private var appModel
    @Binding var path: [SettingsRoute]
    let openDestination: (RootTabs.SidebarDestination) -> Void
    let reconnect: () -> Void
    let diagnose: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                self.connectionCard
                self.connectionActions
                Text("Agent control")
                    .font(OpenClawType.headline)
                self.agentControlCard
                Text("App settings")
                    .font(OpenClawType.headline)
                self.appSettingsCard
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 20)
        }
        .scrollIndicators(.hidden)
        .background(Color(uiColor: .systemBackground))
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("reference-settings-screen")
    }

    private var connectionCard: some View {
        VStack(spacing: 10) {
            ReferenceAppIcon(size: 44)
            HStack(spacing: 6) {
                Text("\(self.appModel.activeAgentName) (Main)")
                    .font(OpenClawType.headline)
                HStack(spacing: 3) {
                    Circle().fill(self.connectionColor).frame(width: 5, height: 5)
                    Text(self.connectionTitle).font(OpenClawType.caption2SemiBold)
                }
                .foregroundStyle(self.connectionColor)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(self.connectionColor.opacity(0.12), in: Capsule())
            }
            VStack(spacing: 7) {
                self.detailRow(label: "Address", value: self.gatewayAddress)
                self.detailRow(label: "Server", value: "OpenClaw gateway")
                self.detailRow(label: "Agents", value: self.appModel.gatewayAgents.count.formatted())
            }
            .padding(.top, 4)
        }
        .padding(16)
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18))
        .overlay { RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: .separator).opacity(0.3)) }
    }

    private var connectionActions: some View {
        HStack(spacing: 10) {
            Button(action: self.reconnect) {
                Label("Reconnect", systemImage: "arrow.triangle.2.circlepath")
                    .font(OpenClawType.subheadSemiBold)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .background(Color(uiColor: .systemBackground), in: Capsule())
            .overlay { Capsule().stroke(Color(uiColor: .separator).opacity(0.42)) }

            Button(action: self.diagnose) {
                Label("Diagnose", systemImage: "cross.case")
                    .font(OpenClawType.subheadSemiBold)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(OpenClawBrand.info)
            .background(OpenClawBrand.info.opacity(0.08), in: Capsule())
            .overlay { Capsule().stroke(OpenClawBrand.info.opacity(0.2)) }
        }
    }

    private var agentControlCard: some View {
        VStack(spacing: 0) {
            self.destinationRow(title: "Overview", systemImage: "chart.bar", value: nil) {
                AgentProTab(directRoute: .agents, headerTitle: "Overview", openSettings: { self.path.append(.gateway) })
            }
            Divider().padding(.leading, 48)
            self.actionRow(title: "Workboard", systemImage: "folder", value: nil) {
                self.openDestination(.workboard)
            }
            Divider().padding(.leading, 48)
            self.destinationRow(title: "Skill workshop", systemImage: "hammer", value: nil) {
                AgentProTab(
                    directRoute: .skills,
                    headerTitle: "Skill workshop",
                    openSettings: { self.path.append(.gateway) })
            }
            Divider().padding(.leading, 48)
            self.actionRow(title: "Sessions", systemImage: "dot.radiowaves.left.and.right", value: nil) {
                self.openDestination(.sessions)
            }
            Divider().padding(.leading, 48)
            self.destinationRow(title: "Dreaming", systemImage: "moon.stars", value: nil) {
                AgentProTab(
                    directRoute: .dreaming,
                    headerTitle: "Dreaming",
                    openSettings: { self.path.append(.gateway) })
            }
            Divider().padding(.leading, 48)
            self.destinationRow(title: "Instances", systemImage: "server.rack", value: nil) {
                AgentProTab(
                    directRoute: .instances,
                    headerTitle: "Instances",
                    openSettings: { self.path.append(.gateway) })
            }
            Divider().padding(.leading, 48)
            self.destinationRow(title: "Usage", systemImage: "chart.pie", value: nil) {
                AgentProTab(directRoute: .usage, headerTitle: "Usage", openSettings: { self.path.append(.gateway) })
            }
            Divider().padding(.leading, 48)
            Button {
                self.path.append(.channels)
            } label: {
                self.rowLabel(
                    title: "Channels / Integrations",
                    systemImage: "point.3.connected.trianglepath.dotted",
                    value: nil)
            }
            .buttonStyle(.plain)
        }
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18))
        .overlay { RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: .separator).opacity(0.3)) }
    }

    private var appSettingsCard: some View {
        VStack(spacing: 0) {
            self.settingsRouteRow(title: "Approvals", systemImage: "checkmark.shield", route: .approvals)
            Divider().padding(.leading, 48)
            self.settingsRouteRow(title: "Permissions", systemImage: "person.2", route: .permissions)
            Divider().padding(.leading, 48)
            self.settingsRouteRow(
                title: "Channels",
                systemImage: "point.3.connected.trianglepath.dotted",
                route: .channels)
            Divider().padding(.leading, 48)
            self.settingsRouteRow(title: "Skills", systemImage: "sparkles", route: .skills)
            Divider().padding(.leading, 48)
            self.settingsRouteRow(title: "Voice & Talk", systemImage: "waveform", route: .voice)
            Divider().padding(.leading, 48)
            NavigationLink {
                AppearanceSettingsScreen()
            } label: {
                self.rowLabel(title: "Appearance", systemImage: "circle.lefthalf.filled", value: nil)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings-appearance-row")
            Divider().padding(.leading, 48)
            self.settingsRouteRow(title: "Diagnostics", systemImage: "stethoscope", route: .diagnostics)
            Divider().padding(.leading, 48)
            self.settingsRouteRow(title: "Privacy", systemImage: "hand.raised", route: .privacy)
            Divider().padding(.leading, 48)
            self.settingsRouteRow(title: "Apple Watch", systemImage: "applewatch", route: .appleWatch)
            Divider().padding(.leading, 48)
            self.settingsRouteRow(title: "About", systemImage: "info.circle", route: .about)
            Divider().padding(.leading, 48)
            self.settingsRouteRow(title: "Licenses", systemImage: "doc.text", route: .licenses)
        }
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18))
        .overlay { RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: .separator).opacity(0.3)) }
    }

    private func settingsRouteRow(
        title: LocalizedStringKey,
        systemImage: String,
        route: SettingsRoute) -> some View
    {
        Button {
            self.path.append(route)
        } label: {
            self.rowLabel(title: title, systemImage: systemImage, value: nil)
        }
        .buttonStyle(.plain)
    }

    private func detailRow(label: LocalizedStringKey, value: String) -> some View {
        HStack {
            Text(label).font(OpenClawType.subheadSemiBold)
            Spacer()
            Text(verbatim: value)
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private func destinationRow(
        title: LocalizedStringKey,
        systemImage: String,
        value: String?,
        @ViewBuilder destination: () -> some View) -> some View
    {
        NavigationLink(destination: destination()) {
            self.rowLabel(title: title, systemImage: systemImage, value: value)
        }
        .buttonStyle(.plain)
    }

    private func actionRow(
        title: LocalizedStringKey,
        systemImage: String,
        value: String?,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            self.rowLabel(title: title, systemImage: systemImage, value: value)
        }
        .buttonStyle(.plain)
    }

    private func rowLabel(title: LocalizedStringKey, systemImage: String, value: String?) -> some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(.secondary)
                .frame(width: 22)
            Text(title).font(OpenClawType.subheadSemiBold)
            Spacer()
            if let value {
                Text(verbatim: value).font(OpenClawType.subhead).foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
    }

    private var gatewayAddress: String {
        let name = self.appModel.gatewayServerName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if name?.isEmpty == false {
            return name!
        }
        let address = self.appModel.gatewayRemoteAddress?.trimmingCharacters(in: .whitespacesAndNewlines)
        return address?.isEmpty == false ? address! : "Local network"
    }

    private var connectionTitle: LocalizedStringKey {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected: "Online"
        case .connecting: "Connecting"
        case .error: "Error"
        case .disconnected: "Offline"
        }
    }

    private var connectionColor: Color {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected: OpenClawBrand.statusSuccess
        case .connecting: OpenClawBrand.info
        case .error: OpenClawBrand.statusError
        case .disconnected: .secondary
        }
    }
}
