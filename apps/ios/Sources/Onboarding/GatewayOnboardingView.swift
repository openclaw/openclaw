import SwiftUI
import UIKit

struct GatewayOnboardingView: View {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    @Environment(GatewayConnectionController.self) private var gatewayController: GatewayConnectionController
    @AppStorage("gateway.preferredStableID") private var preferredGatewayStableID: String = ""
    @AppStorage("gateway.lastDiscoveredStableID") private var lastDiscoveredGatewayStableID: String = ""
    @AppStorage("gateway.manual.enabled") private var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") private var manualGatewayHost: String = ""
    @AppStorage("gateway.manual.port") private var manualGatewayPort: Int = 18789
    @AppStorage("gateway.manual.tls") private var manualGatewayTLS: Bool = true
    @State private var connectStatusText: String?
    @State private var connectingGatewayID: String?
    @State private var showManualEntry: Bool = false
    @State private var manualGatewayPortText: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Connect to your gateway to get started.")
                    LabeledContent("Discovery", value: self.gatewayController.discoveryStatusText)
                    LabeledContent("Status", value: self.appModel.gatewayStatusText)
                }

                Section("Gateways") {
                    self.gatewayList()
                }

                Section {
                    DisclosureGroup(isExpanded: self.$showManualEntry) {
                        TextField("Host", text: self.$manualGatewayHost)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()

                        TextField("Port (optional)", text: self.manualPortBinding)
                            .keyboardType(.numberPad)

                        Toggle("Use TLS", isOn: self.$manualGatewayTLS)

                        Button {
                            Task { await self.connectManual() }
                        } label: {
                            if self.connectingGatewayID == "manual" {
                                HStack(spacing: 8) {
                                    ProgressView()
                                        .progressViewStyle(.circular)
                                    Text("Connecting...")
                                }
                            } else {
                                Text("Connect manual gateway")
                            }
                        }
                        .disabled(self.connectingGatewayID != nil || self.manualGatewayHost
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                            .isEmpty || !self.manualPortIsValid)

                        Button("Paste gateway URL") {
                            self.pasteGatewayURL()
                        }

                        Text(
                            "Use this when discovery is blocked. "
                                + "Leave port empty for 443 on tailnet DNS (TLS) or 18789 otherwise.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } label: {
                        Text("Manual gateway")
                    }
                }

                if let text = self.connectStatusText {
                    Section {
                        Text(text)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
        }
            .navigationTitle("Connect Gateway")
            .onAppear {
                self.syncManualPortText()
            }
            .onChange(of: self.manualGatewayPort) { _, _ in
                self.syncManualPortText()
            }
            .onChange(of: self.appModel.gatewayServerName) { _, _ in
                self.connectStatusText = nil
            }
        }
    }

    @ViewBuilder
    private func gatewayList() -> some View {
        if self.gatewayController.gateways.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("No gateways found yet.")
                    .foregroundStyle(.secondary)
                Text("Make sure you are on the same Wi-Fi as your gateway, or your tailnet DNS is set.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                if let lastKnown = GatewaySettingsStore.loadLastGatewayConnection() {
                    Button {
                        Task { await self.connectLastKnown() }
                    } label: {
                        self.lastKnownButtonLabel(host: lastKnown.host, port: lastKnown.port)
                    }
                    .disabled(self.connectingGatewayID != nil)
                    .buttonStyle(.borderedProminent)
                    .tint(self.appModel.seamColor)
                }
            }
        } else {
            ForEach(self.gatewayController.gateways) { gateway in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(gateway.name)
                        let detailLines = self.gatewayDetailLines(gateway)
                        ForEach(detailLines, id: \.self) { line in
                            Text(line)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()

                    Button {
                        Task { await self.connect(gateway) }
                    } label: {
                        if self.connectingGatewayID == gateway.id {
                            ProgressView()
                                .progressViewStyle(.circular)
                        } else {
                            Text("Connect")
                        }
                    }
                    .disabled(self.connectingGatewayID != nil)
                }
            }
        }
    }

    private func connect(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        self.connectingGatewayID = gateway.id
        self.manualGatewayEnabled = false
        self.preferredGatewayStableID = gateway.stableID
        GatewaySettingsStore.savePreferredGatewayStableID(gateway.stableID)
        self.lastDiscoveredGatewayStableID = gateway.stableID
        GatewaySettingsStore.saveLastDiscoveredGatewayStableID(gateway.stableID)
        defer { self.connectingGatewayID = nil }
        await self.gatewayController.connect(gateway)
    }

    private func connectLastKnown() async {
        self.connectingGatewayID = "last-known"
        defer { self.connectingGatewayID = nil }
        await self.gatewayController.connectLastKnown()
    }

    private var manualPortBinding: Binding<String> {
        Binding(
            get: { self.manualGatewayPortText },
            set: { newValue in
                let filtered = newValue.filter(\.isNumber)
                if self.manualGatewayPortText != filtered {
                    self.manualGatewayPortText = filtered
                }
                if filtered.isEmpty {
                    if self.manualGatewayPort != 0 {
                        self.manualGatewayPort = 0
                    }
                } else if let port = Int(filtered), self.manualGatewayPort != port {
                    self.manualGatewayPort = port
                }
            })
    }

    private var manualPortIsValid: Bool {
        if self.manualGatewayPortText.isEmpty { return true }
        return self.manualGatewayPort >= 1 && self.manualGatewayPort <= 65535
    }

    private func syncManualPortText() {
        if self.manualGatewayPort > 0 {
            let next = String(self.manualGatewayPort)
            if self.manualGatewayPortText != next {
                self.manualGatewayPortText = next
            }
        } else if !self.manualGatewayPortText.isEmpty {
            self.manualGatewayPortText = ""
        }
    }

    @ViewBuilder
    private func lastKnownButtonLabel(host: String, port: Int) -> some View {
        if self.connectingGatewayID == "last-known" {
            HStack(spacing: 8) {
                ProgressView()
                    .progressViewStyle(.circular)
                Text("Connecting...")
            }
            .frame(maxWidth: .infinity)
        } else {
            HStack(spacing: 8) {
                Image(systemName: "bolt.horizontal.circle.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connect last known")
                    Text("\(host):\(port)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func connectManual() async {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else {
            self.connectStatusText = "Failed: host required"
            return
        }
        guard self.manualPortIsValid else {
            self.connectStatusText = "Failed: invalid port"
            return
        }

        self.connectingGatewayID = "manual"
        self.manualGatewayEnabled = true
        defer { self.connectingGatewayID = nil }

        await self.gatewayController.connectManual(
            host: host,
            port: self.manualGatewayPort,
            useTLS: self.manualGatewayTLS)
    }

    private func pasteGatewayURL() {
        guard let text = UIPasteboard.general.string else {
            self.connectStatusText = "Clipboard is empty."
            return
        }
        if self.applyGatewayInput(text) {
            self.connectStatusText = nil
            self.showManualEntry = true
        } else {
            self.connectStatusText = "Could not parse gateway URL."
        }
    }

    private func applyGatewayInput(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        if let components = URLComponents(string: trimmed),
           let host = components.host?.trimmingCharacters(in: .whitespacesAndNewlines),
           !host.isEmpty
        {
            let scheme = components.scheme?.lowercased()
            let defaultPort: Int = {
                let hostLower = host.lowercased()
                if (scheme == "wss" || scheme == "https"), hostLower.hasSuffix(".ts.net") {
                    return 443
                }
                return 18789
            }()
            let port = components.port ?? defaultPort
            if scheme == "wss" || scheme == "https" {
                self.manualGatewayTLS = true
            } else if scheme == "ws" || scheme == "http" {
                self.manualGatewayTLS = false
            }
            self.manualGatewayHost = host
            self.manualGatewayPort = port
            self.manualGatewayPortText = String(port)
            return true
        }

        if let hostPort = SettingsNetworkingHelpers.parseHostPort(from: trimmed) {
            self.manualGatewayHost = hostPort.host
            self.manualGatewayPort = hostPort.port
            self.manualGatewayPortText = String(hostPort.port)
            return true
        }

        return false
    }

    private func gatewayDetailLines(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> [String] {
        var lines: [String] = []
        if let lanHost = gateway.lanHost { lines.append("LAN: \(lanHost)") }
        if let tailnet = gateway.tailnetDns { lines.append("Tailnet: \(tailnet)") }

        let gatewayPort = gateway.gatewayPort
        let canvasPort = gateway.canvasPort
        if gatewayPort != nil || canvasPort != nil {
            let gw = gatewayPort.map(String.init) ?? "-"
            let canvas = canvasPort.map(String.init) ?? "-"
            lines.append("Ports: gateway \(gw) / canvas \(canvas)")
        }

        if lines.isEmpty {
            lines.append(gateway.debugID)
        }

        return lines
    }
}
