import SwiftUI

/// Local consent remains reachable when the embedded Dashboard cannot load.
struct AppleHealthSettingsSection: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @AppStorage(HealthAuthorization.enabledKey) private var summariesEnabled = false
    @State private var consentGeneration: UInt64?
    @State private var permissionTask: Task<Void, Never>?
    @State private var errorMessage: String?

    var body: some View {
        Section {
            SettingsDetailRow("Apple Health Summaries", value: .localized(
                self.summariesEnabled ? "Enabled" : "Off"))
            if self.summariesEnabled {
                Button {
                    HealthAuthorization.disable()
                    self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
                } label: {
                    Text("Turn Off Summaries")
                        .font(OpenClawType.body)
                }
                .accessibilityIdentifier("settings-health-disable")
            } else {
                Button {
                    self.consentGeneration = self.appModel.operatorAuthorityGeneration
                } label: {
                    Text("Enable Apple Health Summaries")
                        .font(OpenClawType.body)
                }
                .disabled(!HealthAuthorization.isAvailable || self.permissionTask != nil)
                .accessibilityIdentifier("settings-health-enable")
            }
            if self.permissionTask != nil {
                ProgressView()
            }
            if !HealthAuthorization.isAvailable {
                Text("Health data is unavailable on this device.")
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
            }
        } footer: {
            Text(verbatim: IOSDeviceSettingsConsent.healthSummary.detail)
                .font(OpenClawType.footnote)
        }
        .alert(
            IOSDeviceSettingsConsent.healthSummary.title,
            isPresented: Binding(
                get: { self.consentGeneration != nil },
                set: { if !$0 { self.consentGeneration = nil } }),
            presenting: self.consentGeneration)
        { generation in
            Button(role: .cancel) {} label: {
                Text("Cancel")
                    .font(OpenClawType.subheadSemiBold)
            }
            Button {
                self.enableSummaries(generation: generation)
            } label: {
                Text("Allow")
                    .font(OpenClawType.subheadSemiBold)
            }
        } message: { _ in
            Text(verbatim: IOSDeviceSettingsConsent.healthSummary.detail)
                .font(OpenClawType.subhead)
        }
        .alert("Could not enable Apple Health Summaries", isPresented: Binding(
                get: { self.errorMessage != nil },
                set: { if !$0 { self.errorMessage = nil } }))
        {
            Button(role: .cancel) {} label: {
                Text("OK")
                    .font(OpenClawType.subheadSemiBold)
            }
            } message: {
                Text(verbatim: self.errorMessage ?? "")
                    .font(OpenClawType.subhead)
            }
            .onDisappear { self.cancelPermissionRequest() }
                .onChange(of: self.appModel.operatorAuthorityGeneration) { _, _ in
                    self.cancelPermissionRequest()
                }
    }

    private func enableSummaries(generation: UInt64) {
        guard self.permissionTask == nil else { return }
        self.permissionTask = Task { @MainActor in
            defer { self.permissionTask = nil }
            do {
                try await HealthAuthorization.enable {
                    self.appModel.operatorAuthorityGeneration == generation
                }
                self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            } catch is CancellationError {
                // Leaving this screen or changing Gateways retires the pending choice.
            } catch {
                self.errorMessage = error.localizedDescription
            }
        }
    }

    private func cancelPermissionRequest() {
        self.consentGeneration = nil
        self.permissionTask?.cancel()
    }
}
