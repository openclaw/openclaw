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
        let prettyPlatform = inst.platform.flatMap { self.prettyPlatform($0) }
        let device = DeviceModelCatalog.presentation(
            deviceFamily: inst.deviceFamily,
            modelIdentifier: inst.modelIdentifier)

        HStack(alignment: .top, spacing: 12) {
            self.leadingDeviceIcon(inst, device: device)
                .frame(width: 28, height: 28, alignment: .center)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(inst.host ?? "unknown host").font(.subheadline.bold())
                    if let ip = inst.ip { Text("(") + Text(ip).monospaced() + Text(")") }
                }

                HStack(spacing: 8) {
                    if let version = inst.version {
                        self.label(icon: "shippingbox", text: version)
                    }

                    if let device {
                        // Avoid showing generic "Mac"/"iPhone"/etc; prefer the concrete model name.
                        let family = (inst.deviceFamily ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        let isGeneric = !family.isEmpty && device.title == family
                        if !isGeneric {
                            if let prettyPlatform {
                                self.label(icon: device.symbol, text: "\(device.title) · \(prettyPlatform)")
                            } else {
                                self.label(icon: device.symbol, text: device.title)
                            }
                        } else if let prettyPlatform, let platform = inst.platform {
                            self.label(icon: self.platformIcon(platform), text: prettyPlatform)
                        }
                    } else if let prettyPlatform, let platform = inst.platform {
                        self.label(icon: self.platformIcon(platform), text: prettyPlatform)
                    }

                    if let mode = inst.mode { self.label(icon: "network", text: mode) }
                }
                .layoutPriority(1)

                if !isGateway, self.shouldShowUpdateRow(inst) {
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)

                        // Last local input is helpful for interactive nodes, but noisy/meaningless for the gateway.
                        if let secs = inst.lastInputSeconds {
                            self.label(icon: "clock", text: "\(secs)s ago")
                        }

                        if let update = self.updateSummaryText(inst, isGateway: isGateway) {
                            self.label(icon: "arrow.clockwise", text: update)
                                .help(self.presenceUpdateSourceHelp(inst.reason ?? ""))
                        }
                    }
                    .foregroundStyle(.secondary)
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
                if icon == Self.androidSymbolToken {
                    AndroidMark()
                        .foregroundStyle(.secondary)
                        .frame(width: 12, height: 12, alignment: .center)
                } else if self.isSystemSymbolAvailable(icon) {
                    Image(systemName: icon).foregroundStyle(.secondary).font(.caption)
                }
            }
            Text(text)
        }
        .font(.footnote)
    }

    @ViewBuilder
    private func leadingDeviceIcon(_ inst: InstanceInfo, device: DevicePresentation?) -> some View {
        let symbol = self.leadingDeviceSymbol(inst, device: device)
        if symbol == Self.androidSymbolToken {
            AndroidMark()
                .foregroundStyle(.secondary)
                .frame(width: 24, height: 24, alignment: .center)
                .accessibilityHidden(true)
        } else {
            Image(systemName: symbol)
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
    }

    private static let androidSymbolToken = "android"

    private func leadingDeviceSymbol(_ inst: InstanceInfo, device: DevicePresentation?) -> String {
        let family = (inst.deviceFamily ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if family == "android" {
            return Self.androidSymbolToken
        }

        if let title = device?.title.lowercased() {
            if title.contains("mac studio") {
                return self.safeSystemSymbol("macstudio", fallback: "desktopcomputer")
            }
            if title.contains("macbook") {
                return self.safeSystemSymbol("laptopcomputer", fallback: "laptopcomputer")
            }
            if title.contains("ipad") {
                return self.safeSystemSymbol("ipad", fallback: "ipad")
            }
            if title.contains("iphone") {
                return self.safeSystemSymbol("iphone", fallback: "iphone")
            }
        }

        if let symbol = device?.symbol {
            return self.safeSystemSymbol(symbol, fallback: "cpu")
        }

        if let platform = inst.platform {
            return self.safeSystemSymbol(self.platformIcon(platform), fallback: "cpu")
        }

        return "cpu"
    }

    private func shouldShowUpdateRow(_ inst: InstanceInfo) -> Bool {
        if inst.lastInputSeconds != nil { return true }
        if self.updateSummaryText(inst, isGateway: false) != nil { return true }
        return false
    }

    private func safeSystemSymbol(_ preferred: String, fallback: String) -> String {
        if self.isSystemSymbolAvailable(preferred) { return preferred }
        return fallback
    }

    private func isSystemSymbolAvailable(_ name: String) -> Bool {
        NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil
    }

    private struct AndroidMark: View {
        var body: some View {
            GeometryReader { geo in
                let w = geo.size.width
                let h = geo.size.height
                let headHeight = h * 0.68
                let headWidth = w * 0.92
                let headY = h * 0.18
                let corner = headHeight * 0.28

                ZStack {
                    RoundedRectangle(cornerRadius: corner, style: .continuous)
                        .frame(width: headWidth, height: headHeight)
                        .position(x: w / 2, y: headY + headHeight / 2)

                    Circle()
                        .frame(width: max(1, w * 0.1), height: max(1, w * 0.1))
                        .position(x: w * 0.38, y: headY + headHeight * 0.55)
                        .blendMode(.destinationOut)

                    Circle()
                        .frame(width: max(1, w * 0.1), height: max(1, w * 0.1))
                        .position(x: w * 0.62, y: headY + headHeight * 0.55)
                        .blendMode(.destinationOut)

                    Rectangle()
                        .frame(width: max(1, w * 0.08), height: max(1, h * 0.18))
                        .rotationEffect(.degrees(-25))
                        .position(x: w * 0.34, y: h * 0.12)

                    Rectangle()
                        .frame(width: max(1, w * 0.08), height: max(1, h * 0.18))
                        .rotationEffect(.degrees(25))
                        .position(x: w * 0.66, y: h * 0.12)
                }
                .compositingGroup()
            }
        }
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
