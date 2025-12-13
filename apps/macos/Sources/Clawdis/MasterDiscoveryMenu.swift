import SwiftUI

struct MasterDiscoveryInlineList: View {
    @ObservedObject var discovery: MasterDiscoveryModel
    var onSelect: (MasterDiscoveryModel.DiscoveredMaster) -> Void

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
                        Button {
                            self.onSelect(master)
                        } label: {
                            HStack(spacing: 8) {
                                Text(master.displayName)
                                    .lineLimit(1)
                                Spacer()
                                if let host = master.tailnetDns ?? master.lanHost {
                                    Text(host)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(10)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color(NSColor.controlBackgroundColor)))
            }
        }
        .help("Discover Clawdis masters on your LAN")
    }
}

struct MasterDiscoveryMenu: View {
    @ObservedObject var discovery: MasterDiscoveryModel
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
