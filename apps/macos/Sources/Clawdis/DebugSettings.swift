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
                    Button("Restart app") { self.relaunch() }
                    Button("Reveal app in Finder") { self.revealApp() }
                    Button("Restart Gateway") { DebugActions.restartGateway() }
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

    private func relaunch() {
        let url = Bundle.main.bundleURL
        let task = Process()
        task.launchPath = "/usr/bin/open"
        task.arguments = [url.path]
        try? task.run()
        task.waitUntilExit()
        NSApp.terminate(nil)
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
