import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct DebugSettings: View {
    @AppStorage(modelCatalogPathKey) private var modelCatalogPath: String = ModelCatalogLoader.defaultPath
    @AppStorage(modelCatalogReloadKey) private var modelCatalogReloadBump: Int = 0
    @State private var modelsCount: Int?
    @State private var modelsLoading = false
    @State private var modelsError: String?
    @ObservedObject private var relayManager = RelayProcessManager.shared
    @State private var relayRootInput: String = RelayProcessManager.shared.projectRootPath()
    @State private var sessionStorePath: String = SessionLoader.defaultStorePath
    @State private var sessionStoreSaveError: String?
    @State private var debugSendInFlight = false
    @State private var debugSendStatus: String?
    @State private var debugSendError: String?

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                LabeledContent("PID") { Text("\(ProcessInfo.processInfo.processIdentifier)") }
                LabeledContent("Log file") {
                    Button("Open pino log") { self.openLog() }
                        .help(self.pinoLogPath)
                    Text(self.pinoLogPath)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                LabeledContent("Binary path") { Text(Bundle.main.bundlePath).font(.footnote) }
                LabeledContent("Relay status") {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(self.relayManager.status.label)
                        Text("Restarts: \(self.relayManager.restartCount)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Relay stdout/stderr")
                        .font(.caption.weight(.semibold))
                    ScrollView {
                        Text(self.relayManager.log.isEmpty ? "—" : self.relayManager.log)
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
                        TextField("Path to clawdis repo", text: self.$relayRootInput)
                            .textFieldStyle(.roundedBorder)
                            .font(.caption.monospaced())
                            .onSubmit { self.saveRelayRoot() }
                        Button("Save") { self.saveRelayRoot() }
                            .buttonStyle(.borderedProminent)
                        Button("Reset") {
                            let def = FileManager.default.homeDirectoryForCurrentUser
                                .appendingPathComponent("Projects/clawdis").path
                            self.relayRootInput = def
                            self.saveRelayRoot()
                        }
                        .buttonStyle(.bordered)
                    }
                    Text("Used for pnpm/node fallback and PATH population when launching the relay.")
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
                                Label(self.modelsLoading ? "Reloading…" : "Reload models", systemImage: "arrow.clockwise")
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
                    Task { _ = await NotificationManager().send(title: "Clawdis", body: "Test notification", sound: nil) }
                }
                .buttonStyle(.bordered)
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

                    if let debugSendStatus {
                        Text(debugSendStatus)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if let debugSendError {
                        Text(debugSendError)
                            .font(.caption)
                            .foregroundStyle(.red)
                    } else {
                        Text("Uses the Voice Wake path: forwards over SSH when configured, otherwise runs locally via rpc.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack {
                    Button("Restart app") { self.relaunch() }
                    Button("Reveal app in Finder") { self.revealApp() }
                    Button("Restart relay") { self.restartRelay() }
                }
                .buttonStyle(.bordered)
                Spacer(minLength: 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .task {
            await self.reloadModels()
            self.loadSessionStorePath()
        }
    }

    private var pinoLogPath: String {
        let df = DateFormatter()
        df.calendar = Calendar(identifier: .iso8601)
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = "yyyy-MM-dd"
        let today = df.string(from: Date())
        // Prefer rolling log; fall back to legacy single-file path.
        let rolling = URL(fileURLWithPath: "/tmp/clawdis/clawdis-\(today).log").path
        if FileManager.default.fileExists(atPath: rolling) { return rolling }
        return "/tmp/clawdis.log"
    }

    private func openLog() {
        let path = self.pinoLogPath
        let url = URL(fileURLWithPath: path)
        if !FileManager.default.fileExists(atPath: path) {
            let alert = NSAlert()
            alert.messageText = "Log file not found"
            alert.informativeText = path
            alert.runModal()
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private func restartRelay() {
        Task { @MainActor in
            self.relayManager.stop()
            try? await Task.sleep(nanoseconds: 300_000_000)
            self.relayManager.setActive(true)
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

        let message = "This is a debug test from the Mac app. Reply with \"Debug test works (and a funny pun)\" if you received that."
        let config = await MainActor.run { AppStateStore.shared.voiceWakeForwardConfig }
        let trimmedTarget = config.target.trimmingCharacters(in: .whitespacesAndNewlines)
        let shouldForward = config.enabled && !trimmedTarget.isEmpty

        if shouldForward {
            let result = await VoiceWakeForwarder.forward(transcript: message, config: config)
            await MainActor.run {
                self.debugSendInFlight = false
                switch result {
                case .success:
                    self.debugSendStatus = "Forwarded via \(trimmedTarget). Await reply."
                    self.debugSendError = nil
                case let .failure(error):
                    let detail = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                    self.debugSendStatus = "Forward failed: \(detail)"
                    self.debugSendError = nil
                }
            }
            return
        }

        do {
            let status = await AgentRPC.shared.status()
            if !status.ok {
                try await AgentRPC.shared.start()
            }

            let rpcResult = await AgentRPC.shared.send(
                text: message,
                thinking: "low",
                session: "main",
                deliver: true,
                to: nil)

            await MainActor.run {
                self.debugSendInFlight = false
                if rpcResult.ok {
                    self.debugSendStatus = "Sent locally via voice wake path."
                    self.debugSendError = nil
                } else {
                    let reason = rpcResult.error?.trimmingCharacters(in: .whitespacesAndNewlines)
                    let detail = (reason?.isEmpty == false)
                        ? reason!
                        : "No error returned. Check /tmp/clawdis.log or rpc output."
                    self.debugSendStatus = "Local send failed: \(detail)"
                    self.debugSendError = nil
                }
            }
        } catch {
            await MainActor.run {
                self.debugSendInFlight = false
                let detail = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                self.debugSendStatus = "Local send failed: \(detail)"
                self.debugSendError = nil
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
        RelayProcessManager.shared.setProjectRoot(path: self.relayRootInput)
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

    private func configURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis")
            .appendingPathComponent("clawdis.json")
    }
}
