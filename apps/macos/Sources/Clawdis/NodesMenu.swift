import AppKit
import SwiftUI

struct NodeMenuEntryFormatter {
    static func isGateway(_ entry: InstanceInfo) -> Bool {
        entry.mode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "gateway"
    }

    static func isLocal(_ entry: InstanceInfo) -> Bool {
        entry.mode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "local"
    }

    static func primaryName(_ entry: InstanceInfo) -> String {
        if self.isGateway(entry) {
            let host = entry.host?.nonEmpty
            if let host, host.lowercased() != "gateway" { return host }
            return "Gateway"
        }
        return entry.host?.nonEmpty ?? entry.id
    }

    static func summaryText(_ entry: InstanceInfo) -> String {
        entry.text.nonEmpty ?? self.primaryName(entry)
    }

    static func roleText(_ entry: InstanceInfo) -> String {
        if self.isGateway(entry) { return "gateway" }
        if let mode = entry.mode?.nonEmpty { return mode }
        return "node"
    }

    static func detailLeft(_ entry: InstanceInfo) -> String {
        let role = self.roleText(entry)
        if let ip = entry.ip?.nonEmpty { return "\(ip) · \(role)" }
        return role
    }

    static func detailRight(_ entry: InstanceInfo) -> String? {
        var parts: [String] = []
        if let platform = self.platformText(entry) { parts.append(platform) }
        if let version = entry.version?.nonEmpty { parts.append("v\(version)") }
        if parts.isEmpty { return nil }
        return parts.joined(separator: " · ")
    }

    static func platformText(_ entry: InstanceInfo) -> String? {
        if let raw = entry.platform?.nonEmpty {
            return self.prettyPlatform(raw) ?? raw
        }
        if let family = entry.deviceFamily?.lowercased() {
            if family.contains("mac") { return "macOS" }
            if family.contains("iphone") { return "iOS" }
            if family.contains("ipad") { return "iPadOS" }
            if family.contains("android") { return "Android" }
        }
        return nil
    }

    private static func prettyPlatform(_ raw: String) -> String? {
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

    private static func parsePlatform(_ raw: String) -> (prefix: String, version: String?) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return ("", nil) }
        let parts = trimmed.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        let prefix = parts.first?.lowercased() ?? ""
        let versionToken = parts.dropFirst().first
        return (prefix, versionToken)
    }

    static func leadingSymbol(_ entry: InstanceInfo) -> String {
        if self.isGateway(entry) { return self.safeSystemSymbol("dot.radiowaves.left.and.right", fallback: "network") }
        if let family = entry.deviceFamily?.lowercased() {
            if family.contains("mac") {
                return self.safeSystemSymbol("laptopcomputer", fallback: "laptopcomputer")
            }
            if family.contains("iphone") { return self.safeSystemSymbol("iphone", fallback: "iphone") }
            if family.contains("ipad") { return self.safeSystemSymbol("ipad", fallback: "ipad") }
        }
        if let platform = entry.platform?.lowercased() {
            if platform.contains("mac") { return self.safeSystemSymbol("laptopcomputer", fallback: "laptopcomputer") }
            if platform.contains("ios") { return self.safeSystemSymbol("iphone", fallback: "iphone") }
            if platform.contains("android") { return self.safeSystemSymbol("cpu", fallback: "cpu") }
        }
        return "cpu"
    }

    static func isAndroid(_ entry: InstanceInfo) -> Bool {
        let family = entry.deviceFamily?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return family == "android"
    }

    private static func safeSystemSymbol(_ preferred: String, fallback: String) -> String {
        if NSImage(systemSymbolName: preferred, accessibilityDescription: nil) != nil { return preferred }
        return fallback
    }
}

struct NodeMenuRowView: View {
    let entry: InstanceInfo
    let width: CGFloat
    @Environment(\.menuItemHighlighted) private var isHighlighted

    private var primaryColor: Color {
        self.isHighlighted ? Color(nsColor: .selectedMenuItemTextColor) : .primary
    }

    private var secondaryColor: Color {
        self.isHighlighted ? Color(nsColor: .selectedMenuItemTextColor).opacity(0.85) : .secondary
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            self.leadingIcon
                .frame(width: 22, height: 22, alignment: .center)

            VStack(alignment: .leading, spacing: 2) {
                Text(NodeMenuEntryFormatter.primaryName(self.entry))
                    .font(.callout.weight(NodeMenuEntryFormatter.isGateway(self.entry) ? .semibold : .regular))
                    .foregroundStyle(self.primaryColor)
                    .lineLimit(1)
                    .truncationMode(.middle)

                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(NodeMenuEntryFormatter.detailLeft(self.entry))
                        .font(.caption)
                        .foregroundStyle(self.secondaryColor)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Spacer(minLength: 0)

                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let right = NodeMenuEntryFormatter.detailRight(self.entry) {
                            Text(right)
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(self.secondaryColor)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }

                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(self.secondaryColor)
                            .padding(.leading, 2)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        }
        .padding(.vertical, 8)
        .padding(.leading, 18)
        .padding(.trailing, 12)
        .frame(width: max(1, self.width), alignment: .leading)
    }

    @ViewBuilder
    private var leadingIcon: some View {
        if NodeMenuEntryFormatter.isAndroid(self.entry) {
            AndroidMark()
                .foregroundStyle(self.secondaryColor)
        } else {
            Image(systemName: NodeMenuEntryFormatter.leadingSymbol(self.entry))
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(self.secondaryColor)
        }
    }
}

struct AndroidMark: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let headHeight = h * 0.68
            let headWidth = w * 0.92
            let headX = (w - headWidth) * 0.5
            let headY = (h - headHeight) * 0.5
            let corner = min(w, h) * 0.18
            RoundedRectangle(cornerRadius: corner, style: .continuous)
                .frame(width: headWidth, height: headHeight)
                .position(x: headX + headWidth * 0.5, y: headY + headHeight * 0.5)
        }
    }
}
