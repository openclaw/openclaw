import SwiftUI

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
