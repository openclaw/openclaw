import SwiftUI

extension View {
    func gatewayActionsDialog(
        isPresented: Binding<Bool>,
        gatewayProfiles: [GatewaySettingsStore.GatewayProfile],
        activeGatewayProfileID: String?,
        onSwitchGateway: @escaping (GatewaySettingsStore.GatewayProfile) -> Void,
        onDisconnect: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void) -> some View
    {
        let switchableProfiles = gatewayProfiles.filter { profile in
            profile.id != activeGatewayProfileID
        }
        return self.confirmationDialog(
            "Gateway",
            isPresented: isPresented,
            titleVisibility: .visible)
        {
            ForEach(switchableProfiles.prefix(GatewaySettingsStore.maxSavedGatewayProfiles())) { profile in
                Button("Switch to \(profile.displayName)") {
                    onSwitchGateway(profile)
                }
            }
            Button("Disconnect", role: .destructive) {
                onDisconnect()
            }
            Button("Open Settings") {
                onOpenSettings()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if switchableProfiles.isEmpty {
                Text("Disconnect from the gateway?")
            } else {
                Text("Switch to another saved gateway or disconnect.")
            }
        }
    }
}
