import AppKit
import SwiftUI

struct InstancesSettings: View {
    var store: InstancesStore

    init(store: InstancesStore = .shared) {
        self.store = store
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.header
            if let err = store.lastError {
                Text("Error: \(err)")
                    .foregroundStyle(.red)
            } else if let info = store.statusMessage {
                Text(info)
                    .foregroundStyle(.secondary)
            }
            if self.store.instances.isEmpty {
                Text("No instances reported yet.")
                    .foregroundStyle(.secondary)
            } else {
                List(self.store.instances) { inst in
                    self.instanceRow(inst)
                }
                .listStyle(.inset)
            }
            Spacer()
        }
        .onAppear { self.store.start() }
        .onDisappear { self.store.stop() }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Connected Instances")
                    .font(.headline)
                Text("Latest presence beacons from Clawdis nodes. Updated periodically.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if self.store.isLoading {
                ProgressView()
            } else {
                Button {
                    Task { await self.store.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .help("Refresh")
            }
        }
    }

    @ViewBuilder
    private func instanceRow(_ inst: InstanceInfo) -> some View {
        let isGateway = (inst.mode ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "gateway"

        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(inst.host ?? "unknown host").font(.subheadline.bold())
                if let ip = inst.ip { Text("(") + Text(ip).monospaced() + Text(")") }
            }
            HStack(spacing: 8) {
                if let version = inst.version {
                    self.label(icon: "shippingbox", text: version)
                }
                if let platform = inst.platform, let prettyPlatform = self.prettyPlatform(platform) {
                    self.label(icon: self.platformIcon(platform), text: prettyPlatform)
                }
                if let device = DeviceModelCatalog.presentation(
                    deviceFamily: inst.deviceFamily,
                    modelIdentifier: inst.modelIdentifier)
                {
                    // Avoid showing generic "Mac"/"iPhone"/etc when we already show the OS + role.
                    let family = (inst.deviceFamily ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !family.isEmpty, device.title != family {
                        self.label(icon: device.symbol, text: device.title)
                    } else if family.isEmpty {
                        self.label(icon: device.symbol, text: device.title)
                    }
                }

                // Last local input is helpful for interactive nodes, but noisy/meaningless for the gateway.
                if !isGateway, let secs = inst.lastInputSeconds {
                    self.label(icon: "clock", text: "\(secs)s ago")
                }
                if let mode = inst.mode { self.label(icon: "network", text: mode) }

                if let update = self.updateSummaryText(inst, isGateway: isGateway) {
                    self.label(icon: "arrow.clockwise", text: update)
                        .help(self.presenceUpdateSourceHelp(inst.reason ?? ""))
                }
            }
        }
        .padding(.vertical, 6)
        .help(inst.text)
        .contextMenu {
            Button("Copy Debug Summary") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(inst.text, forType: .string)
            }
        }
    }

    private func label(icon: String?, text: String) -> some View {
        HStack(spacing: 4) {
            if let icon {
                Image(systemName: icon).foregroundStyle(.secondary).font(.caption)
            }
            Text(text)
        }
        .font(.footnote)
    }

    private func platformIcon(_ raw: String) -> String {
        let (prefix, _) = self.parsePlatform(raw)
        switch prefix {
        case "macos":
            return "laptopcomputer"
        case "ios":
            return "iphone"
        case "ipados":
            return "ipad"
        case "tvos":
            return "appletv"
        case "watchos":
            return "applewatch"
        default:
            return "cpu"
        }
    }

    private func prettyPlatform(_ raw: String) -> String? {
        let (prefix, version) = self.parsePlatform(raw)
        if prefix.isEmpty { return nil }
        let name: String = switch prefix {
        case "macos": "macOS"
        case "ios": "iOS"
        case "ipados": "iPadOS"
        case "tvos": "tvOS"
        case "watchos": "watchOS"
        default: prefix.prefix(1).uppercased() + prefix.dropFirst()
        }
        guard let version, !version.isEmpty else { return name }
        let parts = version.split(separator: ".").map(String.init)
        if parts.count >= 2 {
            return "\(name) \(parts[0]).\(parts[1])"
        }
        return "\(name) \(version)"
    }

    private func parsePlatform(_ raw: String) -> (prefix: String, version: String?) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return ("", nil) }
        let parts = trimmed.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        let prefix = parts.first?.lowercased() ?? ""
        let versionToken = parts.dropFirst().first
        return (prefix, versionToken)
    }

    private func presenceUpdateSourceShortText(_ reason: String) -> String? {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        switch trimmed {
        case "self":
            return "Self"
        case "connect":
            return "Connect"
        case "disconnect":
            return "Disconnect"
        case "launch":
            return "Launch"
        case "periodic":
            return "Heartbeat"
        case "instances-refresh":
            return "Instances"
        case "seq gap":
            return "Resync"
        default:
            return trimmed
        }
    }

    private func updateSummaryText(_ inst: InstanceInfo, isGateway: Bool) -> String? {
        // For gateway rows, omit the "updated via/by" provenance entirely.
        if isGateway {
            return nil
        }

        let age = inst.ageDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !age.isEmpty else { return nil }

        let source = self.presenceUpdateSourceShortText(inst.reason ?? "")
        if let source, !source.isEmpty {
            return "\(age) · \(source)"
        }
        return age
    }

    private func presenceUpdateSourceHelp(_ reason: String) -> String {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return "Why this presence entry was last updated (debug marker)."
        }
        return "Why this presence entry was last updated (debug marker). Raw: \(trimmed)"
    }
}

#if DEBUG
struct InstancesSettings_Previews: PreviewProvider {
    static var previews: some View {
        InstancesSettings(store: .preview())
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
