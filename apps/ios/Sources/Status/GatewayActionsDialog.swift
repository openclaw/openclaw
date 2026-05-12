import SwiftUI

extension View {
    func gatewayActionsDialog(
        isPresented: Binding<Bool>,
        onDisconnect: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void) -> some View
    {
        self.confirmationDialog(
            "Gateway",
            isPresented: isPresented,
            titleVisibility: .visible)
        {
            Button("Disconnect", role: .destructive) {
                onDisconnect()
            }
            Button("Open Settings") {
                onOpenSettings()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Disconnect from the gateway?")
        }
    }
}
