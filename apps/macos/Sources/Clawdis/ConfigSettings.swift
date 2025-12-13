import SwiftUI

@MainActor
struct ConfigSettings: View {
    private let isPreview = ProcessInfo.processInfo.isPreview
    @State private var configModel: String = ""
    @State private var customModel: String = ""
    @State private var configSaving = false
    @State private var hasLoaded = false
    @State private var models: [ModelChoice] = []
    @State private var modelsLoading = false
    @State private var modelError: String?
    @AppStorage(modelCatalogPathKey) private var modelCatalogPath: String = ModelCatalogLoader.defaultPath
    @AppStorage(modelCatalogReloadKey) private var modelCatalogReloadBump: Int = 0
    @State private var allowAutosave = false
    @State private var heartbeatMinutes: Int?
    @State private var heartbeatBody: String = "HEARTBEAT"
    @AppStorage(webChatEnabledKey) private var webChatEnabled: Bool = true
    @AppStorage(webChatPortKey) private var webChatPort: Int = 18788

    // clawd browser settings (stored in ~/.clawdis/clawdis.json under "browser")
    @State private var browserEnabled: Bool = true
    @State private var browserControlUrl: String = "http://127.0.0.1:18790"
    @State private var browserColorHex: String = "#FF4500"
    @State private var browserAttachOnly: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Clawdis CLI config")
                .font(.title3.weight(.semibold))
            Text("Edit ~/.clawdis/clawdis.json (inbound.reply.agent/session).")
                .font(.callout)
                .foregroundStyle(.secondary)

            LabeledContent("Model") {
                VStack(alignment: .leading, spacing: 6) {
                    Picker("Model", selection: self.$configModel) {
                        ForEach(self.models) { choice in
                            Text(
                                "\(choice.name) — \(choice.provider.uppercased())")
                                .tag(choice.id)
                        }
                        Text("Manual entry…").tag("__custom__")
                    }
                    .labelsHidden()
                    .frame(width: 360)
                    .disabled(self.modelsLoading || (!self.modelError.isNilOrEmpty && self.models.isEmpty))
                    .onChange(of: self.configModel) { _, _ in
                        self.autosaveConfig()
                    }

                    if self.configModel == "__custom__" {
                        TextField("Enter model ID", text: self.$customModel)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 320)
                            .onChange(of: self.customModel) { _, newValue in
                                self.configModel = newValue
                                self.autosaveConfig()
                            }
                    }

                    if let contextLabel = self.selectedContextLabel {
                        Text(contextLabel)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    if let modelError {
                        Text(modelError)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            LabeledContent("Heartbeat") {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 12) {
                        Stepper(
                            value: Binding(
                                get: { self.heartbeatMinutes ?? 10 },
                                set: { self.heartbeatMinutes = $0; self.autosaveConfig() }),
                            in: 0...720)
                        {
                            Text("Every \(self.heartbeatMinutes ?? 10) min")
                        }
                        .help("Set to 0 to disable automatic heartbeats")

                        TextField("HEARTBEAT", text: self.$heartbeatBody)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 240)
                            .onChange(of: self.heartbeatBody) { _, _ in
                                self.autosaveConfig()
                            }
                            .help("Message body sent on each heartbeat")
                    }

                    Text("Heartbeats keep Pi sessions warm; 0 minutes disables them.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            Divider().padding(.vertical, 4)

            LabeledContent("Web chat") {
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("Enable embedded web chat (loopback only)", isOn: self.$webChatEnabled)
                        .toggleStyle(.switch)
                        .frame(width: 320, alignment: .leading)
                    HStack(spacing: 8) {
                        Text("Port")
                        TextField("18788", value: self.$webChatPort, formatter: NumberFormatter())
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 100)
                            .disabled(!self.webChatEnabled)
                    }
                    Text(
                        """
                        Mac app connects to the gateway’s loopback web chat on this port.
                        Remote mode uses SSH -L to forward it.
                        """)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: 480, alignment: .leading)
                }
            }

            Divider().padding(.vertical, 4)

            LabeledContent("Browser (clawd)") {
                VStack(alignment: .leading, spacing: 8) {
                    Toggle("Enable clawd browser control", isOn: self.$browserEnabled)
                        .toggleStyle(.switch)
                        .frame(width: 360, alignment: .leading)
                        .onChange(of: self.browserEnabled) { _, _ in self.autosaveConfig() }

                    HStack(spacing: 8) {
                        Text("Control URL")
                        TextField("http://127.0.0.1:18790", text: self.$browserControlUrl)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 320)
                            .disabled(!self.browserEnabled)
                            .onChange(of: self.browserControlUrl) { _, _ in self.autosaveConfig() }
                    }

                    HStack(spacing: 8) {
                        Text("Accent")
                        TextField("#FF4500", text: self.$browserColorHex)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 120)
                            .disabled(!self.browserEnabled)
                            .onChange(of: self.browserColorHex) { _, _ in self.autosaveConfig() }
                        Circle()
                            .fill(self.browserColor)
                            .frame(width: 12, height: 12)
                            .overlay(Circle().stroke(Color.secondary.opacity(0.25), lineWidth: 1))
                        Text("lobster-orange")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    Toggle("Attach only (never launch)", isOn: self.$browserAttachOnly)
                        .toggleStyle(.switch)
                        .frame(width: 360, alignment: .leading)
                        .disabled(!self.browserEnabled)
                        .onChange(of: self.browserAttachOnly) { _, _ in self.autosaveConfig() }
                        .help("When enabled, the browser server will only connect if the clawd browser is already running.")

                    Text(
                        "Clawd uses a separate Chrome profile and ports (default 18790/18791) so it won’t interfere with your daily browser."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 480, alignment: .leading)
                }
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .onChange(of: self.modelCatalogPath) { _, _ in
            Task { await self.loadModels() }
        }
        .onChange(of: self.modelCatalogReloadBump) { _, _ in
            Task { await self.loadModels() }
        }
        .task {
            guard !self.hasLoaded else { return }
            guard !self.isPreview else { return }
            self.hasLoaded = true
            self.loadConfig()
            await self.loadModels()
            self.allowAutosave = true
        }
    }

    private func configURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis")
            .appendingPathComponent("clawdis.json")
    }

    private func loadConfig() {
        let parsed = self.loadConfigDict()
        let inbound = parsed["inbound"] as? [String: Any]
        let reply = inbound?["reply"] as? [String: Any]
        let agent = reply?["agent"] as? [String: Any]
        let heartbeatMinutes = reply?["heartbeatMinutes"] as? Int
        let heartbeatBody = reply?["heartbeatBody"] as? String
        let browser = parsed["browser"] as? [String: Any]

        let loadedModel = (agent?["model"] as? String) ?? ""
        if !loadedModel.isEmpty {
            self.configModel = loadedModel
            self.customModel = loadedModel
        } else {
            self.configModel = SessionLoader.fallbackModel
            self.customModel = SessionLoader.fallbackModel
        }

        if let heartbeatMinutes { self.heartbeatMinutes = heartbeatMinutes }
        if let heartbeatBody, !heartbeatBody.isEmpty { self.heartbeatBody = heartbeatBody }

        if let browser {
            if let enabled = browser["enabled"] as? Bool { self.browserEnabled = enabled }
            if let url = browser["controlUrl"] as? String, !url.isEmpty { self.browserControlUrl = url }
            if let color = browser["color"] as? String, !color.isEmpty { self.browserColorHex = color }
            if let attachOnly = browser["attachOnly"] as? Bool { self.browserAttachOnly = attachOnly }
        }
    }

    private func autosaveConfig() {
        guard self.allowAutosave else { return }
        Task { await self.saveConfig() }
    }

    private func saveConfig() async {
        guard !self.configSaving else { return }
        self.configSaving = true
        defer { self.configSaving = false }

        var root = self.loadConfigDict()
        var inbound = root["inbound"] as? [String: Any] ?? [:]
        var reply = inbound["reply"] as? [String: Any] ?? [:]
        var agent = reply["agent"] as? [String: Any] ?? [:]
        var browser = root["browser"] as? [String: Any] ?? [:]

        let chosenModel = (self.configModel == "__custom__" ? self.customModel : self.configModel)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = chosenModel
        if !trimmedModel.isEmpty { agent["model"] = trimmedModel }

        reply["agent"] = agent

        if let heartbeatMinutes {
            reply["heartbeatMinutes"] = heartbeatMinutes
        }

        let trimmedBody = self.heartbeatBody.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedBody.isEmpty {
            reply["heartbeatBody"] = trimmedBody
        }

        inbound["reply"] = reply
        root["inbound"] = inbound

        browser["enabled"] = self.browserEnabled
        let trimmedUrl = self.browserControlUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedUrl.isEmpty { browser["controlUrl"] = trimmedUrl }
        let trimmedColor = self.browserColorHex.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedColor.isEmpty { browser["color"] = trimmedColor }
        browser["attachOnly"] = self.browserAttachOnly
        root["browser"] = browser

        do {
            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            let url = self.configURL()
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
        } catch {}
    }

    private func loadConfigDict() -> [String: Any] {
        let url = self.configURL()
        guard let data = try? Data(contentsOf: url) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private var browserColor: Color {
        let raw = self.browserColorHex.trimmingCharacters(in: .whitespacesAndNewlines)
        let hex = raw.hasPrefix("#") ? String(raw.dropFirst()) : raw
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return .orange }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        return Color(red: r, green: g, blue: b)
    }

    private func loadModels() async {
        guard !self.modelsLoading else { return }
        self.modelsLoading = true
        self.modelError = nil
        do {
            let loaded = try await ModelCatalogLoader.load(from: self.modelCatalogPath)
            self.models = loaded
            if !self.configModel.isEmpty, !loaded.contains(where: { $0.id == self.configModel }) {
                self.customModel = self.configModel
                self.configModel = "__custom__"
            }
        } catch {
            self.modelError = error.localizedDescription
            self.models = []
        }
        self.modelsLoading = false
    }

    private var selectedContextLabel: String? {
        let chosenId = (self.configModel == "__custom__") ? self.customModel : self.configModel
        guard
            !chosenId.isEmpty,
            let choice = self.models.first(where: { $0.id == chosenId }),
            let context = choice.contextWindow
        else {
            return nil
        }

        let human = context >= 1000 ? "\(context / 1000)k" : "\(context)"
        return "Context window: \(human) tokens"
    }
}

#if DEBUG
struct ConfigSettings_Previews: PreviewProvider {
    static var previews: some View {
        ConfigSettings()
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
