import SwiftUI

@MainActor
struct ConfigSettings: View {
    @State private var configModel: String = ""
    @State private var customModel: String = ""
    @State private var configStorePath: String = SessionLoader.defaultStorePath
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
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Stepper(
                            value: Binding(
                                get: { self.heartbeatMinutes ?? 10 },
                                set: { self.heartbeatMinutes = $0; self.autosaveConfig() }),
                            in: 0...720)
                        {
                            Text("Every \(self.heartbeatMinutes ?? 10) min")
                        }
                        .help("Set to 0 to disable automatic heartbeats")
                    }

                    TextField("HEARTBEAT", text: self.$heartbeatBody)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 320)
                        .onChange(of: self.heartbeatBody) { _, _ in
                            self.autosaveConfig()
                        }
                        .help("Message body sent on each heartbeat")

                    Text("Heartbeats keep Pi sessions warm; 0 minutes disables them.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            LabeledContent("Session store") {
                TextField("Path", text: self.$configStorePath)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 360)
                    .onChange(of: self.configStorePath) { _, _ in
                        self.autosaveConfig()
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
        let url = self.configURL()
        guard let data = try? Data(contentsOf: url) else {
            self.configModel = SessionLoader.fallbackModel
            self.configStorePath = SessionLoader.defaultStorePath
            return
        }
        guard
            let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let inbound = parsed["inbound"] as? [String: Any],
            let reply = inbound["reply"] as? [String: Any]
        else {
            return
        }

        let session = reply["session"] as? [String: Any]
        let agent = reply["agent"] as? [String: Any]
        let heartbeatMinutes = reply["heartbeatMinutes"] as? Int
        let heartbeatBody = reply["heartbeatBody"] as? String

        self.configStorePath = (session?["store"] as? String) ?? SessionLoader.defaultStorePath
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
    }

    private func autosaveConfig() {
        guard self.allowAutosave else { return }
        Task { await self.saveConfig() }
    }

    private func saveConfig() async {
        guard !self.configSaving else { return }
        self.configSaving = true
        defer { self.configSaving = false }

        var session: [String: Any] = [:]
        var agent: [String: Any] = [:]
        var reply: [String: Any] = [:]

        let trimmedStore = self.configStorePath.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedStore.isEmpty { session["store"] = trimmedStore }

        let chosenModel = (self.configModel == "__custom__" ? self.customModel : self.configModel)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = chosenModel
        if !trimmedModel.isEmpty { agent["model"] = trimmedModel }

        reply["session"] = session
        reply["agent"] = agent

        if let heartbeatMinutes {
            reply["heartbeatMinutes"] = heartbeatMinutes
        }

        let trimmedBody = self.heartbeatBody.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedBody.isEmpty {
            reply["heartbeatBody"] = trimmedBody
        }

        let inbound: [String: Any] = ["reply": reply]
        let root: [String: Any] = ["inbound": inbound]

        do {
            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            let url = self.configURL()
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
        } catch {}
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
