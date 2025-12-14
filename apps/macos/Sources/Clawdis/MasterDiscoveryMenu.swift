import SwiftUI

// “master” is part of the discovery protocol naming; keep UI components consistent.
// swiftlint:disable:next inclusive_language
struct MasterDiscoveryInlineList: View {
    var discovery: MasterDiscoveryModel
    var currentTarget: String?
    var onSelect: (MasterDiscoveryModel.DiscoveredMaster) -> Void
    @State private var hoveredMasterID: MasterDiscoveryModel.DiscoveredMaster.ID?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(self.discovery.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if self.discovery.masters.isEmpty {
                Text("No masters found yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(self.discovery.masters.prefix(6)) { master in
                        let target = self.suggestedSSHTarget(master)
                        let selected = target != nil && self.currentTarget?
                            .trimmingCharacters(in: .whitespacesAndNewlines) == target

                        Button {
                            withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                                self.onSelect(master)
                            }
                        } label: {
                            HStack(alignment: .center, spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(master.displayName)
                                        .font(.callout.weight(.semibold))
                                        .lineLimit(1)
                                        .truncationMode(.tail)
                                    if let target {
                                        Text(target)
                                            .font(.caption.monospaced())
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                }
                                Spacer(minLength: 0)
                                if selected {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(Color.accentColor)
                                } else {
                                    Image(systemName: "arrow.right.circle")
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(self.rowBackground(
                                        selected: selected,
                                        hovered: self.hoveredMasterID == master.id)))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(
                                        selected ? Color.accentColor.opacity(0.45) : Color.clear,
                                        lineWidth: 1))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .onHover { hovering in
                            self.hoveredMasterID = hovering ? master
                                .id : (self.hoveredMasterID == master.id ? nil : self.hoveredMasterID)
                        }
                    }
                }
                .padding(10)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color(NSColor.controlBackgroundColor)))
            }
        }
        .help("Click a discovered master to fill the SSH target.")
    }

    private func suggestedSSHTarget(_ master: MasterDiscoveryModel.DiscoveredMaster) -> String? {
        let host = master.tailnetDns ?? master.lanHost
        guard let host else { return nil }
        let user = NSUserName()
        var target = "\(user)@\(host)"
        if master.sshPort != 22 {
            target += ":\(master.sshPort)"
        }
        return target
    }

    private func rowBackground(selected: Bool, hovered: Bool) -> Color {
        if selected { return Color.accentColor.opacity(0.12) }
        if hovered { return Color.secondary.opacity(0.08) }
        return Color.clear
    }
}

// swiftlint:disable:next inclusive_language
struct MasterDiscoveryMenu: View {
    var discovery: MasterDiscoveryModel
    var onSelect: (MasterDiscoveryModel.DiscoveredMaster) -> Void

    var body: some View {
        Menu {
            if self.discovery.masters.isEmpty {
                Button(self.discovery.statusText) {}
                    .disabled(true)
            } else {
                ForEach(self.discovery.masters) { master in
                    Button(master.displayName) { self.onSelect(master) }
                }
            }
        } label: {
            Image(systemName: "dot.radiowaves.left.and.right")
        }
        .help("Discover Clawdis masters on your LAN")
    }
}
