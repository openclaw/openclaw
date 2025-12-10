import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct DebugSettings: View {
    private let isPreview = ProcessInfo.processInfo.isPreview
    @AppStorage(modelCatalogPathKey) private var modelCatalogPath: String = ModelCatalogLoader.defaultPath
    @AppStorage(modelCatalogReloadKey) private var modelCatalogReloadBump: Int = 0
    @AppStorage(iconOverrideKey) private var iconOverrideRaw: String = IconOverrideSelection.system.rawValue
    @State private var modelsCount: Int?
    @State private var modelsLoading = false
    @State private var modelsError: String?
    @ObservedObject private var gatewayManager = GatewayProcessManager.shared
    @ObservedObject private var healthStore = HealthStore.shared
    @State private var gatewayRootInput: String = GatewayProcessManager.shared.projectRootPath()
    @State private var sessionStorePath: String = SessionLoader.defaultStorePath
    @State private var sessionStoreSaveError: String?
    @State private var debugSendInFlight = false
    @State private var debugSendStatus: String?
    @State private var debugSendError: String?
    @State private var portCheckInFlight = false
    @State private var portReports: [DebugActions.PortReport] = []
    @State private var portKillStatus: String?
    @State private var pendingKill: DebugActions.PortListener?
    @AppStorage(webChatSwiftUIEnabledKey) private var webChatSwiftUIEnabled: Bool = false

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                LabeledContent("Health") {
                    HStack(spacing: 8) {
                        Circle().fill(self.healthStore.state.tint).frame(width: 10, height: 10)
                        Text(self.healthStore.summaryLine)
                    }
                }
                LabeledContent("Icon override") {
                    Picker("Icon override", selection: self.bindingOverride) {
                        ForEach(IconOverrideSelection.allCases) { option in
                            Text(option.label).tag(option.rawValue)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 280)
                }
                LabeledContent("CLI helper") {
                    let loc = CLIInstaller.installedLocation()
                    Text(loc ?? "missing")
                        .font(.caption.monospaced())
                        .foregroundStyle(loc == nil ? Color.red : Color.secondary)
                }
                LabeledContent("PID") { Text("\(ProcessInfo.processInfo.processIdentifier)") }
                LabeledContent("Log file") {
                    Button("Open pino log") { DebugActions.openLog() }
                        .help(DebugActions.pinoLogPath())
                    Text(DebugActions.pinoLogPath())
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                LabeledContent("Binary path") { Text(Bundle.main.bundlePath).font(.footnote) }
                LabeledContent("Gateway status") {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(self.gatewayManager.status.label)
                        Text("Restarts: \(self.gatewayManager.restartCount)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Gateway stdout/stderr")
                        .font(.caption.weight(.semibold))
                    ScrollView {
                        Text(self.gatewayManager.log.isEmpty ? "—" : self.gatewayManager.log)
                            .font(.caption.monospaced())
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(height: 180)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2)))
                }
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text("Port diagnostics")
                            .font(.caption.weight(.semibold))
                        if self.portCheckInFlight { ProgressView().controlSize(.small) }
                        Spacer()
                        Button("Check gateway ports") {
                            Task { await self.runPortCheck() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(self.portCheckInFlight)
                    }
                    if let portKillStatus {
                        Text(portKillStatus)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if self.portReports.isEmpty, !self.portCheckInFlight {
                        Text("Check which process owns 18788/18789 and suggest fixes.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(self.portReports) { report in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Port \(report.port)")
                                    .font(.footnote.weight(.semibold))
                                Text(report.summary)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                ForEach(report.listeners) { listener in
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 8) {
                                            Text("\(listener.command) (\(listener.pid))")
                                                .font(.caption.monospaced())
                                                .foregroundStyle(listener.expected ? .secondary : Color.red)
                                                .lineLimit(1)
                                            Spacer()
                                            Button("Kill") {
                                                self.requestKill(listener)
                                            }
                                            .buttonStyle(.bordered)
                                        }
                                        Text(listener.fullCommand)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                            .truncationMode(.middle)
                                    }
                                    .padding(6)
                                    .background(Color.secondary.opacity(0.05))
                                    .cornerRadius(4)
                                }
                            }
                            .padding(8)
                            .background(Color.secondary.opacity(0.08))
                            .cornerRadius(6)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Clawdis project root")
                        .font(.caption.weight(.semibold))
                    HStack(spacing: 8) {
                        TextField("Path to clawdis repo", text: self.$gatewayRootInput)
                            .textFieldStyle(.roundedBorder)
                            .font(.caption.monospaced())
                            .onSubmit { self.saveRelayRoot() }
                        Button("Save") { self.saveRelayRoot() }
                            .buttonStyle(.borderedProminent)
                        Button("Reset") {
                            let def = FileManager.default.homeDirectoryForCurrentUser
                                .appendingPathComponent("Projects/clawdis").path
                            self.gatewayRootInput = def
                            self.saveRelayRoot()
                        }
                        .buttonStyle(.bordered)
                    }
                    Text("Used for pnpm/node fallback and PATH population when launching the gateway.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                LabeledContent("Session store") {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            TextField("Path", text: self.$sessionStorePath)
                                .textFieldStyle(.roundedBorder)
                                .font(.caption.monospaced())
                                .frame(width: 340)
                            Button("Save") { self.saveSessionStorePath() }
                                .buttonStyle(.borderedProminent)
                        }
                        if let sessionStoreSaveError {
                            Text(sessionStoreSaveError)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } else {
                            Text("Used by the CLI session loader; stored in ~/.clawdis/clawdis.json.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                LabeledContent("Model catalog") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(self.modelCatalogPath)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        HStack(spacing: 8) {
                            Button {
                                self.chooseCatalogFile()
                            } label: {
                                Label("Choose models.generated.ts…", systemImage: "folder")
                            }
                            .buttonStyle(.bordered)

                            Button {
                                Task { await self.reloadModels() }
                            } label: {
                                Label(
                                    self.modelsLoading ? "Reloading…" : "Reload models",
                                    systemImage: "arrow.clockwise")
                            }
                            .buttonStyle(.bordered)
                            .disabled(self.modelsLoading)
                        }
                        if let modelsError {
                            Text(modelsError)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } else if let modelsCount {
                            Text("Loaded \(modelsCount) models")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        Text("Used by the Config tab model picker; point at a different build when debugging.")
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                    }
                }
                Toggle("Use SwiftUI web chat (glass, gateway WS)", isOn: self.$webChatSwiftUIEnabled)
                    .toggleStyle(.switch)
                    .help("When enabled, the menu bar chat window/panel uses the native SwiftUI UI instead of the bundled WKWebView.")
                Button("Send Test Notification") {
                    Task { await DebugActions.sendTestNotification() }
                }
                .buttonStyle(.bordered)
                Button("Open Agent Events") {
                    DebugActions.openAgentEventsWindow()
                }
                .buttonStyle(.borderedProminent)
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        Task { await self.sendVoiceDebug() }
                    } label: {
                        Label(
                            self.debugSendInFlight ? "Sending debug voice…" : "Send debug voice",
                            systemImage: self.debugSendInFlight ? "bolt.horizontal.circle" : "waveform")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.debugSendInFlight)

                    if !self.debugSendInFlight {
                        if let debugSendStatus {
                            Text(debugSendStatus)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else if let debugSendError {
                            Text(debugSendError)
                                .font(.caption)
                                .foregroundStyle(.red)
                        } else {
                            Text(
                                """
                                Uses the Voice Wake path: forwards over SSH when configured,
                                otherwise runs locally via rpc.
                                """)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                HStack {
                    Button("Restart app") { DebugActions.restartApp() }
                    Button("Reveal app in Finder") { self.revealApp() }
                    Button("Restart Gateway") { DebugActions.restartGateway() }
                    Button("Clear log") { GatewayProcessManager.shared.clearLog() }
                }
                .buttonStyle(.bordered)
                Spacer(minLength: 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .task {
            guard !self.isPreview else { return }
            await self.reloadModels()
            self.loadSessionStorePath()
        }
        .alert(item: self.$pendingKill) { listener in
            Alert(
                title: Text("Kill \(listener.command) (\(listener.pid))?"),
                message: Text("This process looks expected for the current mode. Kill anyway?"),
                primaryButton: .destructive(Text("Kill")) {
                    Task { await self.killConfirmed(listener.pid) }
                },
                secondaryButton: .cancel())
        }
    }

    @MainActor
    private func runPortCheck() async {
        self.portCheckInFlight = true
        self.portKillStatus = nil
        let reports = await DebugActions.checkGatewayPorts()
        self.portReports = reports
        self.portCheckInFlight = false
    }

    @MainActor
    private func requestKill(_ listener: DebugActions.PortListener) {
        if listener.expected {
            self.pendingKill = listener
        } else {
            Task { await self.killConfirmed(listener.pid) }
        }
    }

    @MainActor
    private func killConfirmed(_ pid: Int32) async {
        let result = await DebugActions.killProcess(Int(pid))
        switch result {
        case .success:
            self.portKillStatus = "Sent kill to \(pid)."
            await self.runPortCheck()
        case let .failure(err):
            self.portKillStatus = "Kill \(pid) failed: \(err.localizedDescription)"
        }
    }

    private func chooseCatalogFile() {
        let panel = NSOpenPanel()
        panel.title = "Select models.generated.ts"
        let tsType = UTType(filenameExtension: "ts")
            ?? UTType(tag: "ts", tagClass: .filenameExtension, conformingTo: .sourceCode)
            ?? .item
        panel.allowedContentTypes = [tsType]
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: self.modelCatalogPath).deletingLastPathComponent()
        if panel.runModal() == .OK, let url = panel.url {
            self.modelCatalogPath = url.path
            self.modelCatalogReloadBump += 1
            Task { await self.reloadModels() }
        }
    }

    private func reloadModels() async {
        guard !self.modelsLoading else { return }
        self.modelsLoading = true
        self.modelsError = nil
        self.modelCatalogReloadBump += 1
        defer { self.modelsLoading = false }
        do {
            let loaded = try await ModelCatalogLoader.load(from: self.modelCatalogPath)
            self.modelsCount = loaded.count
        } catch {
            self.modelsCount = nil
            self.modelsError = error.localizedDescription
        }
    }

    private func sendVoiceDebug() async {
        await MainActor.run {
            self.debugSendInFlight = true
            self.debugSendError = nil
            self.debugSendStatus = nil
        }

        let result = await DebugActions.sendDebugVoice()

        await MainActor.run {
            self.debugSendInFlight = false
            switch result {
            case let .success(message):
                self.debugSendStatus = message
                self.debugSendError = nil
            case let .failure(error):
                self.debugSendStatus = nil
                self.debugSendError = error.localizedDescription
            }
        }
    }

    private func revealApp() {
        let url = Bundle.main.bundleURL
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private func saveRelayRoot() {
        GatewayProcessManager.shared.setProjectRoot(path: self.gatewayRootInput)
    }

    private func loadSessionStorePath() {
        let url = self.configURL()
        guard
            let data = try? Data(contentsOf: url),
            let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let inbound = parsed["inbound"] as? [String: Any],
            let reply = inbound["reply"] as? [String: Any],
            let session = reply["session"] as? [String: Any],
            let path = session["store"] as? String
        else {
            self.sessionStorePath = SessionLoader.defaultStorePath
            return
        }
        self.sessionStorePath = path
    }

    private func saveSessionStorePath() {
        let trimmed = self.sessionStorePath.trimmingCharacters(in: .whitespacesAndNewlines)
        var root: [String: Any] = [:]
        let url = self.configURL()
        if let data = try? Data(contentsOf: url),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
            root = parsed
        }

        var inbound = root["inbound"] as? [String: Any] ?? [:]
        var reply = inbound["reply"] as? [String: Any] ?? [:]
        var session = reply["session"] as? [String: Any] ?? [:]
        session["store"] = trimmed.isEmpty ? SessionLoader.defaultStorePath : trimmed
        reply["session"] = session
        inbound["reply"] = reply
        root["inbound"] = inbound

        do {
            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
            self.sessionStoreSaveError = nil
        } catch {
            self.sessionStoreSaveError = error.localizedDescription
        }
    }

    private var bindingOverride: Binding<String> {
        Binding {
            self.iconOverrideRaw
        } set: { newValue in
            self.iconOverrideRaw = newValue
            if let selection = IconOverrideSelection(rawValue: newValue) {
                Task { @MainActor in
                    AppStateStore.shared.iconOverride = selection
                    WorkActivityStore.shared.resolveIconState(override: selection)
                }
            }
        }
    }

    private func configURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis")
            .appendingPathComponent("clawdis.json")
    }
}

#if DEBUG
struct DebugSettings_Previews: PreviewProvider {
    static var previews: some View {
        DebugSettings()
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
