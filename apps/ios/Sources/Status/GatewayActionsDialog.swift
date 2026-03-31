import SwiftUI

extension View {
    func gatewayActionsDialog(
        isPresented: Binding<Bool>,
        savedGateways: [GatewaySettingsStore.SavedGatewayProfile],
        currentGatewayProfileID: String?,
        onSwitchGateway: @escaping (GatewaySettingsStore.SavedGatewayProfile) -> Void,
        onAddGateway: @escaping () -> Void,
        onDisconnect: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void) -> some View
    {
        self.sheet(isPresented: isPresented) {
            GatewayActionsSheet(
                savedGateways: savedGateways,
                currentGatewayProfileID: currentGatewayProfileID,
                onSwitchGateway: onSwitchGateway,
                onAddGateway: onAddGateway,
                onDisconnect: onDisconnect,
                onOpenSettings: onOpenSettings)
        }
    }
}

private struct GatewayActionsSheet: View {
    let savedGateways: [GatewaySettingsStore.SavedGatewayProfile]
    let currentGatewayProfileID: String?
    let onSwitchGateway: (GatewaySettingsStore.SavedGatewayProfile) -> Void
    let onAddGateway: () -> Void
    let onDisconnect: () -> Void
    let onOpenSettings: () -> Void

    @Environment(\.dismiss) private var dismiss

    private var availableGateways: [GatewaySettingsStore.SavedGatewayProfile] {
        self.savedGateways.filter { $0.id != self.currentGatewayProfileID }
    }

    var body: some View {
        NavigationStack {
            List {
                if !self.availableGateways.isEmpty {
                    Section("Switch Gateway") {
                        ForEach(self.availableGateways) { gateway in
                            Button {
                                self.dismiss()
                                self.onSwitchGateway(gateway)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(gateway.resolvedName)
                                    Text(gateway.addressLabel)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section("Actions") {
                    Button {
                        self.dismiss()
                        self.onAddGateway()
                    } label: {
                        Label("Add Another Gateway", systemImage: "plus.circle")
                    }

                    Button {
                        self.dismiss()
                        self.onOpenSettings()
                    } label: {
                        Label("Open Settings", systemImage: "gearshape")
                    }

                    Button(role: .destructive) {
                        self.dismiss()
                        self.onDisconnect()
                    } label: {
                        Label("Disconnect", systemImage: "xmark.circle")
                    }
                }
            }
            .navigationTitle("Gateways")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        self.dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
