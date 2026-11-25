import OpenClawKit
import SwiftUI
import UIKit
import UserNotifications

enum SettingsRoute: Hashable {
    case gateway
    case gatewayDetails
    case deviceSettings
    case voiceAndTalk
    case permissions
    case accessories
    case chatPreferences
    case storage
    case sidebarPages
    case skills
    case plugins
    case advanced
    case appleWatch
    case espSetup
    case approvals
    case diagnostics
    case licenses
    case about
}

struct ManualGatewaySecurityRows: View {
    let presentation: GatewayManualTransportPresentation
    @Binding var useTLS: Bool
    /// Settings shows the helper as the group footer; onboarding keeps it as a row.
    var showsHelperRow = true

    var body: some View {
        Picker(selection: self.$useTLS) {
            Text("Unencrypted")
                .font(OpenClawType.body)
                .tag(false)
            Text("Secure (TLS)")
                .font(OpenClawType.body)
                .tag(true)
        } label: {
            Text("Connection security")
                .font(SettingsType.label)
        }
        .settingsMenuPicker()
        .disabled(self.presentation.requiresTLS)

        if self.showsHelperRow, let helperText = self.presentation.helperText {
            Text(helperText)
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

/// One text style per role on every Settings page (F26). Each role is a Dynamic Type text
/// style, so sizes follow the user's setting; pages never pick their own size.
enum SettingsType {
    /// Row labels and action rows.
    static var label: Font {
        OpenClawType.body
    }

    /// Current or read-only value at the trailing edge, in secondary ink.
    static var value: Font {
        OpenClawType.body
    }

    /// Second line of a row with a description, in secondary ink.
    static var description: Font {
        OpenClawType.subhead
    }

    /// Section titles, matching the header iOS 26+ draws for a plain titled `Section` in a
    /// grouped list: Body size, regular, sentence case, secondary ink.
    static var sectionTitle: Font {
        OpenClawType.body
    }

    /// Group footers.
    static var footnote: Font {
        OpenClawType.footnote
    }
}

/// The one secondary ink for Settings text: the system secondary label color, which menu pickers
/// already draw their value in. SwiftUI's `.secondary` style resolves to a different gray in a
/// list row (#7f7f7f against #8a8a8e on white), so values beside a picker would not match.
enum SettingsInk {
    static let secondary = Color(uiColor: .secondaryLabel)
}

/// Section title for every Settings group: the system header style in the brand font. Its ink is
/// the header's own (secondary label); adding `.secondary` again would draw it a step lighter.
struct SettingsSectionTitle: View {
    private let text: Text

    init(_ title: LocalizedStringKey) {
        self.text = Text(title)
    }

    init(verbatim title: String) {
        self.text = Text(verbatim: title)
    }

    var body: some View {
        self.text
            .font(SettingsType.sectionTitle)
            .textCase(nil)
    }
}

/// Group footer text for every Settings group.
struct SettingsFootnote: View {
    private let text: Text

    init(_ title: LocalizedStringKey) {
        self.text = Text(title)
    }

    init(verbatim title: String) {
        self.text = Text(verbatim: title)
    }

    var body: some View {
        self.text
            .font(SettingsType.footnote)
    }
}

/// The second Settings row type: label with a description under it, and the trailing value
/// or control centered on the row, where the short row puts it.
struct SettingsDescriptionRow<Trailing: View>: View {
    let label: OpenClawTextValue
    let description: OpenClawTextValue
    let trailing: Trailing
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        _ label: OpenClawTextValue,
        description: OpenClawTextValue,
        @ViewBuilder trailing: () -> Trailing)
    {
        self.label = label
        self.description = description
        self.trailing = trailing()
    }

    var body: some View {
        // Accessibility sizes stack the value or control under the text, so the label never
        // breaks mid-word and the value never truncates beside it.
        if self.dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                self.texts
                self.trailing
            }
        } else {
            HStack(spacing: 12) {
                self.texts
                Spacer(minLength: 8)
                self.trailing
            }
        }
    }

    private var texts: some View {
        VStack(alignment: .leading, spacing: 2) {
            self.label.text
                .font(SettingsType.label)
                .foregroundStyle(.primary)
            self.description.text
                .font(SettingsType.description)
                .foregroundStyle(SettingsInk.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

extension SettingsDescriptionRow where Trailing == SettingsValueText {
    init(_ label: OpenClawTextValue, description: OpenClawTextValue, value: OpenClawTextValue) {
        self.init(label, description: description) { SettingsValueText(value) }
    }
}

/// Trailing value text: the value role's font and ink.
struct SettingsValueText: View {
    let value: OpenClawTextValue

    init(_ value: OpenClawTextValue) {
        self.value = value
    }

    var body: some View {
        self.value.text
            .font(SettingsType.value)
            .foregroundStyle(SettingsInk.secondary)
            .lineLimit(1)
    }
}

extension View {
    /// Menu pickers show their value like every other trailing value: secondary ink.
    func settingsMenuPicker() -> some View {
        self
            .pickerStyle(.menu)
            .tint(.secondary)
    }
}

struct NativeSettingsRowIcon: View {
    let systemName: String
    @ScaledMetric(relativeTo: .body) private var scale = 1.0

    var body: some View {
        Image(systemName: self.systemName)
            .font(.system(size: 15 * self.scale, weight: .regular))
            .symbolRenderingMode(.monochrome)
            .symbolVariant(.none)
            .foregroundStyle(.secondary)
            .opacity(0.88)
            .frame(width: 24 * self.scale)
    }
}

struct SettingsInputRow<Content: View>: View {
    let title: LocalizedStringKey
    let content: Content

    init(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        LabeledContent {
            self.content
                .font(SettingsType.value)
                .foregroundStyle(SettingsInk.secondary)
                .multilineTextAlignment(.trailing)
        } label: {
            // The label never truncates; a long value gives way instead.
            Text(self.title)
                .font(SettingsType.label)
                .fixedSize(horizontal: true, vertical: false)
        }
    }
}

/// The short Settings row: label with its value at the trailing edge. A value too long for
/// the row keeps one line and truncates in the middle (`LabeledContent` would wrap it under
/// the label instead); accessibility sizes stack the full value under the label.
struct SettingsDetailRow: View {
    let label: OpenClawTextValue
    let value: OpenClawTextValue
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(_ label: OpenClawTextValue, value: OpenClawTextValue) {
        self.label = label
        self.value = value
    }

    var body: some View {
        if self.dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                self.label.text
                    .font(SettingsType.label)
                self.value.text
                    .font(SettingsType.value)
                    .foregroundStyle(SettingsInk.secondary)
            }
        } else {
            HStack(spacing: 12) {
                self.label.text
                    .font(SettingsType.label)
                    .fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: 0)
                self.value.text
                    .font(SettingsType.value)
                    .foregroundStyle(SettingsInk.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }
}

/// Trailing mark of a row that is itself the control: a chevron when it acts in the app, an
/// arrow when it opens iOS Settings.
struct SettingsRowAccessory: View {
    let opensSystemSettings: Bool

    var body: some View {
        Image(systemName: self.opensSystemSettings ? "arrow.up.right" : "chevron.right")
            .font(OpenClawType.footnoteSemiBold)
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }
}

/// A short row whose value is a state (never an action word) and whose whole row is the control.
struct SettingsStateRow: View {
    let label: OpenClawTextValue
    let value: OpenClawTextValue
    let opensSystemSettings: Bool
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: self.action) {
            Group {
                if self.dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 2) {
                        self.label.text.font(SettingsType.label)
                        self.trailing
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack(spacing: 12) {
                        self.label.text
                            .font(SettingsType.label)
                            .fixedSize(horizontal: true, vertical: false)
                        Spacer(minLength: 0)
                        self.trailing
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var trailing: some View {
        HStack(spacing: 6) {
            self.value.text
                .font(SettingsType.value)
                .foregroundStyle(SettingsInk.secondary)
                .lineLimit(1)
            SettingsRowAccessory(opensSystemSettings: self.opensSystemSettings)
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
        .tint(.primary)
    }

    private var metadataRow: some View {
        HStack(alignment: .center, spacing: 0) {
            ForEach(Array(self.fields.enumerated()), id: \.element.id) { index, field in
                if index > 0 {
                    Divider()
                        .frame(height: 30)
                }
                self.metadataField(field)
                    .frame(minWidth: 72, maxWidth: .infinity)
                    .padding(.horizontal, 4)
            }
        }
        .frame(minWidth: 240)
    }

    private var metadataColumn: some View {
        VStack(alignment: .center, spacing: 8) {
            ForEach(self.fields) { field in
                self.metadataField(field)
            }
        }
    }

    private func metadataField(_ field: Field) -> some View {
        VStack(alignment: .center, spacing: 1) {
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
        case .setup: String(localized: "Needs setup")
        case .denied: String(localized: "Denied")
        case .notSet: String(localized: "Not enabled")
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
}
