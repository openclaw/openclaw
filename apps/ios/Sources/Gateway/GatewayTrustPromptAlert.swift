import SwiftUI

struct GatewayTrustPromptAlert: ViewModifier {
    @Environment(GatewayConnectionController.self) private var gatewayController: GatewayConnectionController

    func body(content: Content) -> some View {
        content.alert(
            "Trust this gateway?",
            isPresented: Binding(
                get: { self.gatewayController.pendingTrustPrompt != nil },
                set: { _ in
                    // Keep pending trust state until explicit user action.
                    // SwiftUI may set presentation bindings during dismissal; clearing here can
                    // race with the trust button and make accept no-op.
                }),
            presenting: self.gatewayController.pendingTrustPrompt)
        { _ in
            Button("Cancel", role: .cancel) {
                self.gatewayController.declinePendingTrustPrompt()
            }
            Button("Trust and connect") {
                Task { await self.gatewayController.acceptPendingTrustPrompt() }
            }
        } message: { prompt in
            Text(String(
                format: NSLocalizedString(
                    "First-time TLS connection.\n\nVerify this SHA-256 fingerprint out-of-band before trusting:\n%@",
                    comment: "Gateway certificate trust instructions"),
                prompt.fingerprintSha256))
        }
    }
}

extension View {
    func gatewayTrustPromptAlert() -> some View {
        self.modifier(GatewayTrustPromptAlert())
    }
}
