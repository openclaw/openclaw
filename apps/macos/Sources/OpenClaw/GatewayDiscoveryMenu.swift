import OpenClawDiscovery
import SwiftUI

/// Discovery rows for the Connection form; the owning section supplies header and status footer.
struct GatewayDiscoveryInlineList: View {
    var discovery: GatewayDiscoveryModel
    var currentTarget: String?
    var currentUrl: String?
    var transport: AppState.RemoteTransport
    var onSelect: (GatewayDiscoveryModel.DiscoveredGateway) -> Void

    var body: some View {
        if self.discovery.gateways.isEmpty {
            Text("No gateways found yet.")
                .foregroundStyle(.secondary)
        } else {
            ForEach(self.discovery.gateways.prefix(6)) { gateway in
                let display = self.displayInfo(for: gateway)

                Button {
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                        self.onSelect(gateway)
                    }
                } label: {
                    HStack(alignment: .center, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(gateway.displayName)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Text(display.label)
                                .font(.callout.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer(minLength: 0)
                        SelectionStateIndicator(selected: display.selected)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Get connection instructions. A Nearby listing does not verify the Gateway owner.")
            }
        }
    }

    private func displayInfo(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> (label: String, selected: Bool)
    {
        let (endpoint, current) = switch self.transport {
        case .direct: (GatewayDiscoveryHelpers.directUrl(for: gateway), self.currentUrl)
        case .ssh: (GatewayDiscoveryHelpers.sshTarget(for: gateway), self.currentTarget)
        }
        return (
            endpoint ?? "Gateway pairing only",
            endpoint != nil && (current?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") == endpoint)
    }
}
