import SwiftUI

struct SettingsTab: View {
    @EnvironmentObject private var appModel: NodeAppModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage("node.displayName") private var displayName: String = "iOS Node"
    @AppStorage("node.instanceId") private var instanceId: String = UUID().uuidString
    @AppStorage("voiceWake.enabled") private var voiceWakeEnabled: Bool = false
    @StateObject private var discovery = BridgeDiscoveryModel()
    @State private var connectStatus: String?
    @State private var isConnecting = false
    @State private var didAutoConnect = false
    @State private var isShowingBridgeList = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Node") {
                    TextField("Name", text: self.$displayName)
                    Text(self.instanceId)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Voice") {
                    Toggle("Voice Wake", isOn: self.$voiceWakeEnabled)
                        .onChange(of: self.voiceWakeEnabled) { _, newValue in
                            self.appModel.setVoiceWakeEnabled(newValue)
                        }
                }

                Section("Bridge") {
                    LabeledContent("Discovery", value: self.discovery.statusText)
                    LabeledContent("Status", value: self.appModel.bridgeStatusText)
                    if let serverName = self.appModel.bridgeServerName {
                        LabeledContent("Server", value: serverName)

                        Button("Disconnect", role: .destructive) {
                            self.appModel.disconnectBridge()
                        }

                        DisclosureGroup("Switch bridge", isExpanded: self.$isShowingBridgeList) {
                            self.bridgeList(showConnectedRow: true)
                        }
                    } else {
                        self.bridgeList(showConnectedRow: false)
                    }

                    if let connectStatus {
                        Text(connectStatus)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
            .onAppear { self.discovery.start() }
            .onDisappear { self.discovery.stop() }
            .onChange(of: self.discovery.bridges) { _, newValue in
                if self.didAutoConnect { return }
                if self.appModel.bridgeServerName != nil { return }

                let existing = KeychainStore.loadString(
                    service: "com.steipete.clawdis.bridge",
                    account: self.keychainAccount())
                guard let existing, !existing.isEmpty else { return }
                guard let first = newValue.first else { return }

                self.didAutoConnect = true
                self.appModel.connectToBridge(
                    endpoint: first.endpoint,
                    token: existing,
                    nodeId: self.instanceId,
                    displayName: self.displayName,
                    platform: self.platformString(),
                    version: self.appVersion())
                self.connectStatus = nil
            }
            .onChange(of: self.appModel.bridgeServerName) { _, _ in
                self.connectStatus = nil
                self.isShowingBridgeList = false
            }
        }
    }

    @ViewBuilder
    private func bridgeList(showConnectedRow: Bool) -> some View {
        if self.discovery.bridges.isEmpty {
            Text("No bridges found yet.")
                .foregroundStyle(.secondary)
        } else {
            ForEach(self.discovery.bridges) { bridge in
                let isConnected = self.isConnectedBridge(bridge)
                if isConnected, !showConnectedRow {
                    EmptyView()
                } else {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(bridge.name)
                            Text(bridge.debugID)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()

                        if isConnected {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .accessibilityLabel("Connected")
                        } else {
                            Button(self.isConnecting ? "…" : "Connect") {
                                Task { await self.connect(bridge) }
                            }
                            .disabled(self.isConnecting)
                        }
                    }
                }
            }
        }
    }

    private func isConnectedBridge(_ bridge: BridgeDiscoveryModel.DiscoveredBridge) -> Bool {
        guard let serverName = self.appModel.bridgeServerName?.trimmingCharacters(in: .whitespacesAndNewlines),
              !serverName.isEmpty
        else {
            return false
        }
        return bridge.name.localizedCaseInsensitiveContains(serverName)
    }

    private func keychainAccount() -> String {
        "bridge-token.\(self.instanceId)"
    }

    private func platformString() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "iOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    private func appVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    private func connect(_ bridge: BridgeDiscoveryModel.DiscoveredBridge) async {
        self.isConnecting = true
        defer { self.isConnecting = false }

        let existing = KeychainStore.loadString(service: "com.steipete.clawdis.bridge", account: self.keychainAccount())
        do {
            let token: String
            if let existing, !existing.isEmpty {
                token = existing
            } else {
                let newToken = try await BridgeClient().pairAndHello(
                    endpoint: bridge.endpoint,
                    nodeId: self.instanceId,
                    displayName: self.displayName,
                    platform: self.platformString(),
                    version: self.appVersion(),
                    existingToken: nil)
                guard !newToken.isEmpty else {
                    self.connectStatus = "Pairing failed: empty token"
                    return
                }
                _ = KeychainStore.saveString(
                    newToken,
                    service: "com.steipete.clawdis.bridge",
                    account: self.keychainAccount())
                token = newToken
            }

            self.appModel.connectToBridge(
                endpoint: bridge.endpoint,
                token: token,
                nodeId: self.instanceId,
                displayName: self.displayName,
                platform: self.platformString(),
                version: self.appVersion())

            self.connectStatus = "Connected"
        } catch {
            self.connectStatus = "Failed: \(error.localizedDescription)"
        }
    }
}
