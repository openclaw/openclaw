import SwiftUI

struct WatchPairingView: View {
    let gateway: WatchGatewayController
    @State private var installing = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Pair Watch")
                    .font(WatchClawType.title(size: 20))
                if let endpoint = self.gateway.endpointText {
                    Text(endpoint)
                        .font(WatchClawType.body(size: 12))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(self.gateway.statusText)
                    .font(WatchClawType.body(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    WatchNativeTextInput.present(suggestions: []) { code in
                        self.installing = true
                        Task {
                            await self.gateway.configure(
                                setupCode: code, sentAtMs: Int64(Date().timeIntervalSince1970 * 1000))
                            self.installing = false
                        }
                    }
                } label: {
                    Label {
                        Text(self.installing ? "Pairing..." : "Enter setup code")
                            .font(WatchClawType.body(size: 13, weight: .semibold))
                    } icon: {
                        Image(systemName: "key")
                    }
                }
                .disabled(self.installing)
                if self.gateway.setupIncomplete || self.gateway.recoveryRequired {
                    Text("Setup incomplete")
                        .font(WatchClawType.body(size: 13, weight: .semibold))
                        .foregroundStyle(WatchClawStyle.accent)
                }
            }
            .padding(.horizontal, 8)
        }
    }
}
