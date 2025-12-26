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

    static func detailText(_ entry: InstanceInfo) -> String {
        var parts: [String] = []

        if self.isGateway(entry) {
            parts.append("gateway")
        } else if let mode = entry.mode?.nonEmpty {
            parts.append(mode)
        }

        if let ip = entry.ip?.nonEmpty { parts.append(ip) }
        if let version = entry.version?.nonEmpty { parts.append("app \(version)") }
        if let platform = entry.platform?.nonEmpty { parts.append(platform) }

        if parts.isEmpty, let text = entry.text.nonEmpty {
            let trimmed = text
                .replacingOccurrences(of: "Node: ", with: "")
                .replacingOccurrences(of: "Gateway: ", with: "")
            let candidates = trimmed
                .components(separatedBy: " · ")
                .filter { !$0.hasPrefix("mode ") && !$0.hasPrefix("reason ") }
            if !candidates.isEmpty {
                parts.append(contentsOf: candidates.prefix(2))
            }
        }

        if parts.isEmpty {
            parts.append(entry.ageDescription)
        }

        if parts.count > 2 {
            parts = Array(parts.prefix(2))
        }
        return parts.joined(separator: " / ")
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

                Text(NodeMenuEntryFormatter.detailText(self.entry))
                    .font(.caption)
                    .foregroundStyle(self.secondaryColor)
                    .lineLimit(1)
                    .truncationMode(.middle)
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
