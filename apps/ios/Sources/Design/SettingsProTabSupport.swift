import OpenClawKit
import SwiftUI
import UIKit
import UserNotifications

enum SettingsRoute: Hashable {
    case gateway
    case appleWatch
    case approvals
    case diagnostics
    case licenses
    case about
}

/// Canonical label/value list row for Settings and Talk surfaces. Keep every
/// detail row on this view so row typography cannot drift between sections;
/// plain `LabeledContent(String, value:)` renders unbranded system fonts.
struct SettingsDetailRow: View {
    let label: LocalizedStringKey
    let value: OpenClawTextValue

    init(_ label: LocalizedStringKey, value: OpenClawTextValue) {
        self.label = label
        self.value = value
    }

    var body: some View {
        LabeledContent {
            self.value.text
                .font(OpenClawType.subhead)
                .lineLimit(1)
                .truncationMode(.middle)
        } label: {
            Text(self.label)
                .font(OpenClawType.body)
        }
    }
}

struct SettingsBuildMetadataStrip: View {
    let metadata: ArtifactBuildInfo
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.layoutDirection) private var layoutDirection

    private struct Field: Identifiable {
        enum ID: String {
            case version
            case commit
            case built
        }

        let id: ID
        let title: LocalizedStringKey
        let value: String?
        let forceLeftToRight: Bool
    }

    private var fields: [Field] {
        [
            Field(id: .version, title: "Version", value: self.metadata.versionDisplay, forceLeftToRight: true),
            Field(id: .commit, title: "Commit", value: self.metadata.shortCommit, forceLeftToRight: true),
            Field(id: .built, title: "Built", value: self.metadata.localizedBuildDate(), forceLeftToRight: false),
        ]
    }

    var body: some View {
        Group {
            if self.dynamicTypeSize.isAccessibilitySize {
                self.metadataColumn
            } else {
                ViewThatFits(in: .horizontal) {
                    self.metadataRow
                    self.metadataColumn
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(self.metadataAccessibilityLabel)
        .accessibilityActions {
            if self.metadata.gitCommit != nil {
                Button {
                    self.copyCommit()
                } label: {
                    Text("Copy full commit hash")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
            Button {
                self.copyBuildInfo()
            } label: {
                Text("Copy build info")
                    .font(OpenClawType.subheadSemiBold)
            }
        }
        .contextMenu {
            if self.metadata.gitCommit != nil {
                Button {
                    self.copyCommit()
                } label: {
                    Label {
                        Text("Copy Commit")
                            .font(OpenClawType.subheadSemiBold)
                    } icon: {
                        Image(systemName: "number")
                    }
                }
            }
            Button {
                self.copyBuildInfo()
            } label: {
                Label {
                    Text("Copy Build Info")
                        .font(OpenClawType.subheadSemiBold)
                } icon: {
                    Image(systemName: "doc.on.doc")
                }
            }
        }
    }

    private var metadataRow: some View {
        HStack(alignment: .center, spacing: 0) {
            ForEach(Array(self.fields.enumerated()), id: \.element.id) { index, field in
                if index > 0 {
                    Divider()
                        .frame(height: 30)
                }
                self.metadataField(field, alignment: .center)
                    .frame(minWidth: 72, maxWidth: .infinity)
                    .padding(.horizontal, 4)
            }
        }
        .frame(minWidth: 240)
    }

    private var metadataColumn: some View {
        VStack(alignment: .center, spacing: 8) {
            ForEach(self.fields) { field in
                self.metadataField(field, alignment: .center)
            }
        }
    }

    private func metadataField(_ field: Field, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 1) {
            Text(field.title)
                .font(OpenClawType.caption2SemiBold)
                .textCase(.uppercase)
            Group {
                if let value = field.value {
                    Text(verbatim: value)
                } else {
                    Text("Unavailable")
                }
            }
            .font(OpenClawType.monoSmall)
            .lineLimit(1)
            .minimumScaleFactor(0.72)
            .environment(
                \.layoutDirection,
                field.forceLeftToRight ? .leftToRight : self.layoutDirection)
        }
    }

    private var metadataAccessibilityLabel: String {
        let version = self.metadata.versionDisplay
        let commit = self.metadata.spokenCommit
        let timestamp = self.metadata.buildTimestamp
        let built = self.metadata.localizedBuildDate() ?? timestamp
        if let commit, let timestamp, let built {
            return String(
                format: String(
                    localized: "Version %1$@, commit %2$@, built %3$@, timestamp %4$@"),
                version,
                commit,
                built,
                timestamp)
        }
        if let commit {
            return String(
                format: String(
                    localized: "Version %1$@, commit %2$@, build date unavailable"),
                version,
                commit)
        }
        if let timestamp, let built {
            return String(
                format: String(
                    localized: "Version %1$@, commit unavailable, built %2$@, timestamp %3$@"),
                version,
                built,
                timestamp)
        }
        return String(
            format: String(
                localized: "Version %@, commit unavailable, build date unavailable"),
            version)
    }

    private func copyCommit() {
        guard let gitCommit = self.metadata.gitCommit else { return }
        UIPasteboard.general.string = gitCommit
    }

    private func copyBuildInfo() {
        UIPasteboard.general.string = self.metadata.copyText
    }
}

struct SettingsApprovalItem: Identifiable {
    let id: String
    let icon: String
    let title: OpenClawTextValue
    let detail: OpenClawTextValue
    let priority: OpenClawTextValue
    let color: Color
}

struct SettingsApprovalRow: View {
    let item: SettingsApprovalItem

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: self.item.icon)
                .font(OpenClawType.captionBold)
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(self.item.color)
                }
            VStack(alignment: .leading, spacing: 2) {
                self.item.title.text
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                self.item.detail.text
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            self.item.priority.text
                .font(OpenClawType.captionBold)
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

    var allowsNotifications: Bool {
        self == .allowed
    }
}

enum SettingsNotificationPresentation: Equatable {
    case checking
    case enabled
    case off
    case setup
    case denied
    case notSet
    case unknown

    var text: String {
        switch self {
        case .checking: String(localized: "Checking")
        case .enabled: String(localized: "Enabled")
        case .off: String(localized: "Off")
        case .setup: String(localized: "Setup")
        case .denied: String(localized: "Denied")
        case .notSet: String(localized: "Not Enabled")
        case .unknown: String(localized: "Unknown")
        }
    }

    var color: Color {
        switch self {
        case .enabled:
            OpenClawBrand.ok
        case .denied, .setup, .unknown:
            OpenClawBrand.warn
        case .checking, .notSet, .off:
            .secondary
        }
    }

    var isActive: Bool {
        self == .enabled
    }

    var needsAttention: Bool {
        self != .checking && self != .enabled
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
