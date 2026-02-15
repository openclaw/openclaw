import SwiftUI

struct GatewayTrustPromptAlert: ViewModifier {
    @Environment(GatewayConnectionController.self) private var gatewayController: GatewayConnectionController

    private var promptBinding: Binding<GatewayConnectionController.TrustPrompt?> {
        Binding(
            get: { self.gatewayController.pendingTrustPrompt },
            set: { newValue in
                if newValue == nil {
                    self.gatewayController.clearPendingTrustPrompt()
                }
            })
    }

    func body(content: Content) -> some View {
        content.alert(item: self.promptBinding) { prompt in
            Alert(
                title: Text("Trust this gateway?"),
                message: Text(
                    """
                    First-time TLS connection.

                    Verify this SHA-256 fingerprint out-of-band before trusting:
                    \(prompt.fingerprintSha256)
                    """),
                primaryButton: .cancel(Text("Cancel")) {
                    self.gatewayController.declinePendingTrustPrompt()
                },
                secondaryButton: .default(Text("Trust and connect")) {
                    Task { await self.gatewayController.acceptPendingTrustPrompt() }
                })
        }
    }
}

extension View {
    func gatewayTrustPromptAlert() -> some View {
        self.modifier(GatewayTrustPromptAlert())
    }
}

