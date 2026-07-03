import Darwin
import OpenClawKit
import SwiftUI
import UserNotifications

enum SettingsRoute: Hashable {
    case gateway
    case approvals
    case permissions
    case channels
    case voice
    case diagnostics
    case privacy
    case notifications
    case licenses
    case about
}

enum SettingsLayout {
    static let cardRadius: CGFloat = OpenClawProMetric.cardRadius
    static let rowHeight: CGFloat = 58
}

struct SettingsApprovalItem: Identifiable {
    let id: String
    let icon: String
    let title: String
    let detail: String
    let priority: String
    let color: Color
}

struct SettingsApprovalRow: View {
    let item: SettingsApprovalItem

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: self.item.icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(self.item.color)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(self.item.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.item.detail)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(self.item.priority)
                .font(.caption.weight(.bold))
                .foregroundStyle(self.item.color)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background {
                    Capsule()
                        .fill(self.item.color.opacity(0.10))
                }
        }
        .padding(.vertical, 7)
    }
}

enum SettingsNotificationStatus: Equatable {
    case checking
    case allowed
    case notAllowed
    case notSet
    case unknown

    init(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional, .ephemeral:
            self = .allowed
        case .denied:
            self = .notAllowed
        case .notDetermined:
            self = .notSet
        @unknown default:
            self = .unknown
        }
    }

    var text: String {
        switch self {
        case .checking: "Checking"
        case .allowed: "Enabled"
        case .notAllowed: "Denied"
        case .notSet: "Not Enabled"
        case .unknown: "Unknown"
        }
    }

    var actionTitle: String {
        switch self {
        case .notSet:
            "Enable Notifications"
        case .checking:
            "Checking"
        case .allowed:
            "Manage in iOS Settings"
        case .notAllowed, .unknown:
            "Open iOS Settings"
        }
    }

    var actionIcon: String {
        switch self {
        case .allowed:
            "gear"
        case .notAllowed, .unknown:
            "gear.badge"
        case .checking:
            "hourglass"
        case .notSet:
            "bell.badge"
        }
    }

    var color: Color {
        switch self {
        case .allowed:
            OpenClawBrand.ok
        case .notAllowed, .unknown:
            OpenClawBrand.warn
        case .checking, .notSet:
            .secondary
        }
    }

    var shouldOpenNotificationSettings: Bool {
        switch self {
        case .allowed, .notAllowed, .unknown:
            true
        case .checking, .notSet:
            false
        }
    }

    var allowsNotifications: Bool {
        self == .allowed
    }
}

enum SettingsDiagnosticIssue: String, Equatable, CaseIterable {
    case gatewayOffline
    case discoveryUnavailable
    case talkConfigMissing
    case notificationsUnavailable
}

enum SettingsDiagnostics {
    static func issues(
        gatewayConnected: Bool,
        discoveredGatewayCount: Int,
        talkConfigLoaded: Bool,
        notificationsAllowed: Bool) -> [SettingsDiagnosticIssue]
    {
        var issues: [SettingsDiagnosticIssue] = []
        if !gatewayConnected { issues.append(.gatewayOffline) }
        if discoveredGatewayCount == 0 { issues.append(.discoveryUnavailable) }
        if gatewayConnected, !talkConfigLoaded { issues.append(.talkConfigMissing) }
        if !notificationsAllowed { issues.append(.notificationsUnavailable) }
        return issues
    }

    static func issueCount(
        gatewayConnected: Bool,
        discoveredGatewayCount: Int,
        talkConfigLoaded: Bool,
        notificationsAllowed: Bool) -> Int
    {
        self.issues(
            gatewayConnected: gatewayConnected,
            discoveredGatewayCount: discoveredGatewayCount,
            talkConfigLoaded: talkConfigLoaded,
            notificationsAllowed: notificationsAllowed).count
    }

    static func timestamp(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }
}

extension SettingsProTab {
    static func hasTailnetIPv4() -> Bool {
        var addrList: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrList) == 0, let first = addrList else { return false }
        defer { freeifaddrs(addrList) }
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            let isUp = (flags & IFF_UP) != 0
            let isLoopback = (flags & IFF_LOOPBACK) != 0
            guard let addrPtr = ptr.pointee.ifa_addr else { continue }
            let family = addrPtr.pointee.sa_family
            if !isUp || isLoopback || family != UInt8(AF_INET) { continue }
            var addr = addrPtr.pointee
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                &addr,
                socklen_t(addrPtr.pointee.sa_len),
                &buffer,
                socklen_t(buffer.count),
                nil,
                0,
                NI_NUMERICHOST)
            guard result == 0 else { continue }
            let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
            guard let ip = String(bytes: bytes, encoding: .utf8) else { continue }
            if self.isTailnetIPv4(ip) { return true }
        }
        return false
    }

    static func isTailnetHostOrIP(_ host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.hasSuffix(".ts.net") || trimmed.hasSuffix(".ts.net.") { return true }
        return self.isTailnetIPv4(trimmed)
    }

    static func isTailnetIPv4(_ ip: String) -> Bool {
        let parts = ip.split(separator: ".")
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        let a = octets[0]
        let b = octets[1]
        guard (0...255).contains(a), (0...255).contains(b) else { return false }
        return a == 100 && b >= 64 && b <= 127
    }
}

#if DEBUG
#Preview("Gateway settings states") {
    SettingsGatewayStatesPreview()
}

private struct SettingsGatewayStatesPreview: View {
    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.stateSection("Connected") {
                        self.gatewayStatusCard(
                            title: "Gateway online",
                            detail: "Connected to openclaw-gateway.tailnet.ts.net.",
                            value: "online",
                            color: OpenClawBrand.ok)
                        self.gatewayFactsCard(
                            address: "100.88.41.20:18789",
                            server: "openclaw-gateway",
                            discovered: "3",
                            agent: "Aiden")
                    }

                    self.stateSection("Loading") {
                        self.gatewayStatusCard(
                            title: "Checking gateway",
                            detail: "Refreshing connection, discovery, and device trust state.",
                            value: "loading",
                            color: OpenClawBrand.accent)
                        self.gatewayActionsCard(isBusy: true)
                    }

                    self.stateSection("Empty") {
                        self.gatewayStatusCard(
                            title: "No gateway configured",
                            detail: "Scan a setup QR code, paste a setup code, or choose a discovered gateway.",
                            value: "setup",
                            color: .secondary)
                        self.setupActionsCard
                    }

                    self.stateSection("Error") {
                        self.gatewayStatusCard(
                            title: "Tailscale warning",
                            detail: "Tailscale is off on this device. Turn it on, then try again.",
                            value: "network",
                            color: OpenClawBrand.warn)
                    }
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
                .padding(.vertical, 18)
            }
        }
    }

    private func stateSection(
        _ title: String,
        @ViewBuilder content: () -> some View) -> some View
    {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
    }

    private func gatewayStatusCard(
        title: String,
        detail: String,
        value: String,
        color: Color) -> some View
    {
        ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
            ProStatusRow(
                icon: value == "online" ? "antenna.radiowaves.left.and.right" : "wifi.slash",
                title: title,
                detail: detail,
                value: value,
                color: color,
                actionTitle: value == "setup" ? "Scan QR" : nil,
                action: value == "setup" ? {} : nil)
        }
    }

    private func gatewayFactsCard(
        address: String,
        server: String,
        discovered: String,
        agent: String) -> some View
    {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(spacing: 0) {
                self.factRow("Address", value: address)
                Divider()
                self.factRow("Server", value: server)
                Divider()
                self.factRow("Discovered", value: discovered)
                Divider()
                self.factRow("Default Agent", value: agent)
            }
        }
    }

    private func factRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value)
                .font(.caption.weight(.medium))
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(height: SettingsLayout.rowHeight)
    }

    private func gatewayActionsCard(isBusy: Bool) -> some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            HStack(spacing: 10) {
                self.previewButton("Reconnect", systemImage: "arrow.triangle.2.circlepath", isBusy: isBusy)
                self.previewButton("Diagnose", systemImage: "cross.case", isBusy: isBusy)
            }
        }
    }

    private var setupActionsCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    self.previewButton("Scan QR", systemImage: "qrcode.viewfinder", isBusy: false)
                    self.previewButton("Connect", systemImage: "link", isBusy: false)
                }
                Text("Discovered gateways and manual setup live here when the gateway has not connected yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func previewButton(
        _ title: String,
        systemImage: String,
        isBusy: Bool) -> some View
    {
        Button {} label: {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(isBusy)
    }
}
#endif
