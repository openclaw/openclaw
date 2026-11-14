import OpenClawKit
import SwiftUI

/// Settings owns the drafts; the session owns exactly one device connection.
struct ESPDeviceSetupScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var session: ESPSetupSession?
    @State private var action: Task<Void, Never>?
    @State private var actionID: UUID?
    @State private var serviceName = "PROV_OC_"
    @State private var proof = ""
    @State private var manualSSID = ""
    @State private var selectedSSID: Data?
    @State private var password = ""
    @State private var preview: ESPSetupGatewayPreview?
    @State private var status = ""
    @State private var scanner = QRScannerResultHandoff()
    @State private var scanID: UInt64 = 0
    @State private var showScanner = false

    var body: some View {
        List {
            if let session, session.phase != .closed {
                self.deviceSections(session)
            } else {
                self.entrySection
            }
            Section {
                Text(self.status.isEmpty ? (self.session?.message ?? "Open phone setup on the device to begin.") : self
                    .status)
                    .font(OpenClawType.footnote)
                    .accessibilityIdentifier("ESPSetup.Status")
                if let session = self.session, session.receipt != nil,
                   !self.status.isEmpty || session.message != session.receiptMessage
                {
                    Text(session.receiptMessage)
                        .font(OpenClawType.footnote)
                }
            } footer: {
                Text(
                    """
                    You can also use USB setup. Tab5 devices with remote C6 Wi-Fi \
                    require USB setup for their network.
                    """)
                    .font(OpenClawType.footnote)
            }
        }
        .sheet(isPresented: self.$showScanner, onDismiss: self.deliverScan) { self.scannerSheet }
        .onDisappear { self.close() }
        .task(id: self.preview?.link.expiresAtMs) {
            guard let expiry = self.preview?.link.expiresAtMs else { return }
            let delay = max(0, expiry - Int64(Date().timeIntervalSince1970 * 1000))
            do { try await Task.sleep(for: .milliseconds(delay)) } catch { return }
            self.preview = nil
            self.status = "Gateway setup code expired. Prepare a new code."
        }
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .background { self.close() }
        }
        .onChange(of: self.appModel.operatorAuthorityGeneration) { _, _ in
            self.close(message: "The phone's Gateway authority changed. Reopen device setup before continuing.")
        }
        .onChange(of: self.session?.phase) { _, phase in
            if phase == .closed { self.clearDrafts() }
        }
    }

    private var entrySection: some View {
        Section {
            Button {
                self.scanID = self.scanner.beginScan()
                self.showScanner = true
            } label: {
                Label { Text("Scan device QR").font(OpenClawType.body) } icon: { Image(systemName: "qrcode.viewfinder")
                }
            }
            TextField(text: self.$serviceName) {
                Text("Device service name").font(OpenClawType.subhead)
            }
            .font(OpenClawType.subhead)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("ESPSetup.ServiceName")
            self.secretField("Device proof", text: self.$proof)
                .accessibilityIdentifier("ESPSetup.Proof")
            Button {
                do {
                    try self.connect(ESPSetupDiscovery(name: self.serviceName, pop: self.proof))
                } catch {
                    self.status = error.localizedDescription
                }
            } label: { Text("Connect to device").font(OpenClawType.body) }
                .disabled(self.actionID != nil)
                .accessibilityIdentifier("ESPSetup.Connect")
        } header: {
            Text("ESP device").font(OpenClawType.captionSemiBold)
        } footer: {
            Text("Scan the QR shown by the device, or enter its service name and proof exactly as displayed.")
                .font(OpenClawType.footnote)
        }
    }

    @ViewBuilder private func deviceSections(_ session: ESPSetupSession) -> some View {
        Section {
            if !session.deviceLabel.isEmpty {
                Text(verbatim: session.deviceLabel + " · " + session.model).font(OpenClawType.headline)
            }
            if session.phase == .connecting {
                ProgressView { Text("Connecting securely…").font(OpenClawType.body) }
            }
            if !session.comparison.isEmpty {
                Text(verbatim: session.comparison).font(OpenClawType.title1)
                    .accessibilityLabel("Device comparison code")
            }
            if session.phase == .comparing {
                Text("Compare this code with the device. Confirm using the device's physical controls.")
                    .font(OpenClawType.body)
            }
            Button { self.close() } label: { Text("Cancel setup").font(OpenClawType.body) }
        }
        if session.phase == .ready || session.phase == .working {
            self.wifiSection(session)
                .disabled(self.actionID != nil || session.phase != .ready)
            self.gatewaySection(session)
                .disabled(self.actionID != nil || session.phase != .ready)
        }
    }

    private func wifiSection(_ session: ESPSetupSession) -> some View {
        Section {
            Button { self.start { await session.scan() } } label: {
                Text("Scan Wi-Fi networks").font(OpenClawType.body)
            }
            ForEach(session.networks) { network in
                Button {
                    self.selectedSSID = network.ssid
                    self.password = ""
                } label: {
                    HStack {
                        Text(verbatim: network.label).font(OpenClawType.body)
                        Spacer()
                        Text(verbatim: "\(network.rssi) dBm").font(OpenClawType.caption)
                        if self.selectedSSID == network.ssid { Image(systemName: "checkmark") }
                    }
                }
            }
            if self.selectedSSID != nil {
                Button { self.selectedSSID = nil } label: { Text("Enter SSID manually").font(OpenClawType.body) }
            } else {
                TextField(text: self.$manualSSID) { Text("Network name (SSID)").font(OpenClawType.subhead) }
                    .font(OpenClawType.subhead)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            self.secretField("Wi-Fi password (empty for open networks)", text: self.$password)
            Button {
                let ssid = self.selectedSSID ?? Data(self.manualSSID.utf8)
                let password = self.password
                guard (1...32).contains(ssid.count), password.utf8.count <= 64,
                      !ssid.contains(0), !password.utf8.contains(0)
                else {
                    self.status = "Enter an SSID of 1–32 bytes and a password of at most 64 bytes."
                    return
                }
                self.password = ""
                self.start { await session.applyWiFi(ssid: ssid, password: password) }
            } label: { Text("Apply Wi-Fi to device").font(OpenClawType.body) }
        } header: {
            Text("Wi-Fi").font(OpenClawType.captionSemiBold)
        } footer: {
            Text(session
                .truncated ? "The scan is incomplete. You can enter another SSID manually." :
                "Choose a scanned network or enter its exact name. Changes are sent only when you tap Apply.")
                .font(OpenClawType.footnote)
        }
    }

    private func gatewaySection(_ session: ESPSetupSession) -> some View {
        Section {
            if let preview {
                ForEach(Array(preview.link.connectionEndpoints.enumerated()), id: \.offset) { _, endpoint in
                    if let url = endpoint.websocketURL {
                        Text(verbatim: url.absoluteString).font(OpenClawType.subhead)
                            .textSelection(.enabled)
                    }
                }
                Button {
                    self.preview = nil
                    self.start {
                        await session.applyGateway(code: preview.code) {
                            try await preview.authorize(appModel: self.appModel)
                        }
                    }
                } label: { Text("Apply Gateway to device").font(OpenClawType.body) }
                Button { self.preview = nil } label: { Text("Discard setup code").font(OpenClawType.body) }
            } else {
                Button {
                    self.start {
                        do {
                            self.preview = try await ESPSetupGatewayPreview.prepare(appModel: self.appModel)
                        } catch where !Task.isCancelled {
                            self.status = error.localizedDescription
                        } catch {}
                    }
                } label: { Text("Prepare Gateway setup").font(OpenClawType.body) }
                    .disabled(!self.appModel.isOperatorGatewayConnected || !self.appModel.hasOperatorAdminScope)
            }
        } header: {
            Text("Gateway").font(OpenClawType.captionSemiBold)
        } footer: {
            Text(
                """
                Prepare a fresh setup code from this phone's current Gateway. Review every address \
                before applying it to the device. This phone's connection stays the same.
                """)
                .font(OpenClawType.footnote)
        }
    }

    private func secretField(_ title: LocalizedStringKey, text: Binding<String>) -> some View {
        SecureField(text: text, prompt: Text(title).font(OpenClawType.subhead)) {
            Text(title).font(OpenClawType.subhead)
        }
        .font(OpenClawType.subhead)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .accessibilityLabel(Text(title))
    }

    private var scannerSheet: some View {
        let scanID = self.scanID
        return NavigationStack {
            QRScannerView(
                purpose: .espDevice,
                onResult: { result in
                    guard self.scanner.queue(result, scanID: scanID) else { return }
                    self.showScanner = false
                },
                onError: { message in
                    guard self.scanner.isActive(scanID: scanID) else { return }
                    self.status = message
                    self.showScanner = false
                },
                onDismiss: {
                    if self.scanner.isActive(scanID: scanID) { self.showScanner = false }
                })
                .ignoresSafeArea()
                .navigationTitle("Scan device QR")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button {
                            self.scanner.cancel()
                            self.showScanner = false
                        } label: { Text("Cancel").font(OpenClawType.subheadSemiBold) }
                    }
                }
        }
    }

    private func deliverScan() {
        self.scanner.processAfterDismissal { result in
            guard case let .espDevice(discovery) = result else { return }
            self.connect(discovery)
        }
    }

    private func connect(_ discovery: ESPSetupDiscovery) {
        guard self.actionID == nil else { return }
        self.clearDrafts()
        let session = ESPSetupSession(link: ESPSetupBLELink())
        self.session = session
        self.start { await session.connect(discovery) }
    }

    private func start(_ operation: @escaping @MainActor () async -> Void) {
        guard self.actionID == nil else { return }
        self.status = ""
        let id = UUID()
        self.actionID = id
        self.action = Task { @MainActor in
            await operation()
            if self.actionID == id {
                self.actionID = nil
                self.action = nil
            }
        }
    }

    private func clearDrafts() {
        self.action?.cancel()
        self.action = nil
        self.actionID = nil
        self.serviceName = "PROV_OC_"
        self.proof = ""
        self.password = ""
        self.manualSSID = ""
        self.selectedSSID = nil
        self.preview = nil
    }

    private func close(message: String = "Setup closed. Earlier saved changes are not rolled back.") {
        self.clearDrafts()
        self.scanner.cancel()
        self.showScanner = false
        self.status = message
        self.session?.close(message: message)
    }
}
