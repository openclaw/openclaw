import OpenClawKit
import SwiftUI

struct NativeChatSettingsScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @AppStorage(ChatPreferences.showAssistantTraceKey) private var showsAssistantTrace = true
    @AppStorage(ChatPreferences.wrapCodeLinesKey) private var wrapsCodeLines = false
    @AppStorage(ChatPreferences.followUpModeKey) private var followUpMode = ""

    @State private var snapshot: VerbositySnapshot?
    @State private var verbosity = "off"
    @State private var isWorking = false
    @State private var status: String?

    private struct VerbositySnapshot {
        let route: GatewayNodeSessionRoute
        let authority: UInt64
        let hash: String
        let value: String
    }

    private struct ConfigResponse: Decodable {
        struct Config: Decodable {
            struct Agents: Decodable {
                struct Defaults: Decodable {
                    let verboseDefault: String?
                }

                let defaults: Defaults?
            }

            let agents: Agents?
        }

        let hash: String?
        let config: Config
    }

    private struct ConfigPatch: Encodable {
        let raw: String
        let baseHash: String
    }

    var body: some View {
        Form {
            Section {
                Toggle(isOn: self.$showsAssistantTrace) {
                    Text("Show reasoning & tool activity")
                        .font(OpenClawType.body)
                }
                .tint(OpenClawBrand.ok)
                .accessibilityIdentifier("chat-show-reasoning-toggle")
                Toggle(isOn: self.$wrapsCodeLines) {
                    Text("Wrap code lines")
                        .font(OpenClawType.body)
                }
                .tint(OpenClawBrand.ok)
                .accessibilityIdentifier("chat-wrap-code-lines")
            } header: {
                Text("Display").font(OpenClawType.captionSemiBold)
            }

            Section {
                Picker(selection: self.$followUpMode) {
                    Text("Gateway default").font(OpenClawType.body).tag("")
                    Text("Wait for reply").font(OpenClawType.body).tag("followup")
                    Text("Send now").font(OpenClawType.body).tag("steer")
                } label: {
                    Text("Follow-ups").font(OpenClawType.body)
                }
                .accessibilityIdentifier("chat-follow-up-mode")
            }

            Section {
                if self.snapshot != nil {
                    Picker(selection: self.$verbosity) {
                        Text("Off").font(OpenClawType.body).tag("off")
                        Text("On").font(OpenClawType.body).tag("on")
                        Text("Full").font(OpenClawType.body).tag("full")
                    } label: {
                        Text("Verbosity").font(OpenClawType.body)
                    }
                    .disabled(self.isWorking || !self.appModel.hasOperatorAdminScope)
                } else {
                    LabeledContent {
                        if self.isWorking {
                            ProgressView()
                        } else {
                            Text("Unavailable")
                                .font(OpenClawType.subhead)
                                .foregroundStyle(.secondary)
                        }
                    } label: {
                        Text("Verbosity").font(OpenClawType.body)
                    }
                }

                if self.appModel.isOperatorGatewayConnected, self.appModel.hasOperatorAdminScope {
                    Button {
                        Task { await self.saveVerbosity() }
                    } label: {
                        Text("Save").font(OpenClawType.body)
                    }
                    .disabled(self.snapshot == nil || self.isWorking || self.snapshot?.value == self.verbosity)

                    if self.snapshot == nil, !self.isWorking {
                        Button {
                            Task { await self.loadVerbosity() }
                        } label: {
                            Text("Retry").font(OpenClawType.body)
                        }
                    }
                }
                if let status {
                    Text(status)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Gateway default").font(OpenClawType.captionSemiBold)
            }
        }
        .navigationTitle("Chat")
        .task(id: self.appModel.operatorAuthorityGeneration) {
            await self.loadVerbosity()
        }
    }

    private func loadVerbosity() async {
        self.snapshot = nil
        self.status = nil
        guard self.appModel.isOperatorGatewayConnected else {
            self.status = "Connect to a Gateway to change verbosity."
            return
        }
        guard self.appModel.hasOperatorAdminScope else {
            self.status = "Administrator access is required to change the Gateway default."
            return
        }
        let authority = self.appModel.operatorAuthorityGeneration
        let gateway = self.appModel.operatorSession
        self.isWorking = true
        defer { self.isWorking = false }
        do {
            guard let route = await gateway.currentRoute() else { throw CancellationError() }
            let data = try await gateway.request(
                method: "config.get", paramsJSON: "{}", ifCurrentRoute: route)
            try Task.checkCancellation()
            guard authority == self.appModel.operatorAuthorityGeneration,
                  self.appModel.hasOperatorAdminScope
            else { return }
            let config = try JSONDecoder().decode(ConfigResponse.self, from: data)
            guard let hash = config.hash, !hash.isEmpty else {
                self.status = "The Gateway did not return a configuration revision. Retry to load it again."
                return
            }
            let value = config.config.agents?.defaults?.verboseDefault ?? "off"
            guard ["off", "on", "full"].contains(value) else {
                self.status = "This Gateway uses an unsupported verbosity value."
                return
            }
            self.snapshot = VerbositySnapshot(route: route, authority: authority, hash: hash, value: value)
            self.verbosity = value
        } catch is CancellationError {
            return
        } catch {
            guard authority == self.appModel.operatorAuthorityGeneration else { return }
            self.status = "Could not load verbosity. \(error.localizedDescription)"
        }
    }

    private func saveVerbosity() async {
        guard let snapshot, !self.isWorking,
              appModel.hasOperatorAdminScope,
              appModel.isOperatorGatewayConnected,
              snapshot.authority == self.appModel.operatorAuthorityGeneration
        else { return }
        let value = self.verbosity
        let gateway = self.appModel.operatorSession
        self.isWorking = true
        self.status = nil
        defer { self.isWorking = false }
        do {
            let rawData = try JSONSerialization.data(withJSONObject: [
                "agents": ["defaults": ["verboseDefault": value]],
            ])
            guard let raw = String(bytes: rawData, encoding: .utf8),
                  let params = try String(
                      bytes: JSONEncoder().encode(ConfigPatch(raw: raw, baseHash: snapshot.hash)),
                      encoding: .utf8)
            else { throw CocoaError(.fileWriteInapplicableStringEncoding) }
            _ = try await gateway.request(
                method: "config.patch", paramsJSON: params, ifCurrentRoute: snapshot.route)
            guard snapshot.authority == self.appModel.operatorAuthorityGeneration else { return }
            await self.loadVerbosity()
            if self.snapshot?.value == value {
                self.status = "Saved."
            }
        } catch {
            guard snapshot.authority == self.appModel.operatorAuthorityGeneration else { return }
            self.snapshot = nil
            self.status = "Could not save verbosity. Reload before trying again. \(error.localizedDescription)"
        }
    }
}
