import Foundation
import OpenClawKit
import SwiftUI

/// Appears only when the admitted operator route advertises personal files for a shared Gateway.
struct NativePersonalSettingsRow: View {
    @Environment(NodeAppModel.self) private var appModel
    let agentID: String
    let agentName: String
    @State private var access: NativePersonalAccess?

    var body: some View {
        Group {
            if let access,
               access.generation == self.appModel.operatorAuthorityGeneration,
               self.appModel.isOperatorGatewayConnected
            {
                NavigationLink {
                    NativePersonalInstructionsScreen(
                        agentID: self.agentID, agentName: self.agentName, access: access)
                        .id(self.agentID)
                } label: {
                    Label {
                        Text("Personal instructions")
                            .font(SettingsType.label)
                    } icon: {
                        NativeSettingsRowIcon(systemName: "person.text.rectangle")
                    }
                }
            }
        }
        .task(id: self.appModel.operatorAuthorityGeneration) {
            self.access = nil
            guard self.appModel.isOperatorGatewayConnected,
                  !self.appModel.isLocalGatewayFixtureEnabled
            else { return }
            let generation = self.appModel.operatorAuthorityGeneration
            let session = self.appModel.operatorSession
            guard let route = await session.currentRoute(),
                  await session.hasMultipleSessionSharingIdentities(ifCurrentRoute: route) == true,
                  let facts = await session.currentReactionAccess(ifCurrentRoute: route),
                  facts.role == "operator",
                  facts.scopes?.contains("operator.read") == true ||
                  facts.scopes?.contains("operator.admin") == true,
                  facts.methods?.contains("users.personalFile.get") == true,
                  facts.methods?.contains("users.personalFile.set") == true,
                  let profileID = facts.userID,
                  !Task.isCancelled,
                  generation == self.appModel.operatorAuthorityGeneration,
                  await session.currentRoute() == route
            else { return }
            self.access = NativePersonalAccess(route: route, profileID: profileID, generation: generation)
        }
    }
}

private struct NativePersonalAccess {
    let route: GatewayNodeSessionRoute
    let profileID: String
    let generation: UInt64
}

private struct NativePersonalFile: Decodable {
    let agentId: String
    let profileId: String
    let content: String
    let hash: String?
}

private struct NativePersonalInstructionsScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    let agentID: String
    let agentName: String
    let access: NativePersonalAccess
    @State private var file: NativePersonalFile?
    @State private var draft = ""
    @State private var busy = false
    @State private var error: String?
    @State private var saved = false

    private var current: Bool {
        self.appModel.isOperatorGatewayConnected &&
            self.appModel.operatorAuthorityGeneration == self.access.generation
    }

    var body: some View {
        Form {
            if self.current {
                Section {
                    SettingsDescriptionRow(
                        .verbatim(self.agentName),
                        description: "Instructions that this agent uses for you on this shared Gateway.") {}
                }
                if self.file != nil {
                    Section {
                        TextEditor(text: self.$draft)
                            .font(SettingsType.label)
                            .frame(minHeight: 220)
                            .accessibilityLabel("Personal instructions")
                            .disabled(self.busy)
                            .onChange(of: self.draft) { _, _ in self.saved = false }
                    } footer: {
                        SettingsFootnote(verbatim: "\(self.draft.utf16.count.formatted())/\(4000.formatted())")
                    }
                }
                if self.busy {
                    ProgressView()
                }
                if let error = self.error {
                    Section {
                        Text(error)
                            .font(SettingsType.description)
                            .foregroundStyle(OpenClawBrand.danger)
                        Button {
                            Task { await self.load() }
                        } label: {
                            Text("Reload")
                                .font(SettingsType.label)
                        }
                        .disabled(self.busy)
                    }
                }
                if self.saved {
                    Text("Saved")
                        .font(SettingsType.description)
                        .foregroundStyle(SettingsInk.secondary)
                }
            } else {
                Text("Your connection changed. Return to Settings to reopen personal instructions.")
                    .font(SettingsType.label)
            }
        }
        .navigationTitle("Personal instructions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await self.save() }
                } label: {
                    Text("Save")
                        .font(OpenClawType.body)
                }
                .disabled(!self.current || self.busy || self.file == nil ||
                    self.file?.content == self.draft || self.draft.utf16.count > 4000)
            }
        }
        .task { await self.load() }
        .onChange(of: self.appModel.operatorAuthorityGeneration) { _, _ in
            self.file = nil
            self.draft = ""
            self.saved = false
            self.error = nil
        }
    }

    private func load() async {
        guard self.current, !self.busy else { return }
        self.busy = true
        self.error = nil
        self.saved = false
        defer { self.busy = false }
        do {
            let data = try await appModel.operatorSession.request(
                method: "users.personalFile.get",
                paramsJSON: Self.paramsJSON(agentID: self.agentID),
                ifCurrentRoute: self.access.route)
            let loaded = try decode(data)
            guard self.current, !Task.isCancelled else { return }
            self.file = loaded
            self.draft = loaded.content
        } catch {
            guard self.current, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        guard self.current, !self.busy, let file,
              file.agentId == self.agentID, file.profileId == self.access.profileID,
              draft.utf16.count <= 4000
        else { return }
        self.busy = true
        self.error = nil
        self.saved = false
        defer { self.busy = false }
        do {
            let session = self.appModel.operatorSession
            guard await session.hasMultipleSessionSharingIdentities(ifCurrentRoute: self.access.route) == true,
                  let facts = await session.currentReactionAccess(ifCurrentRoute: access.route),
                  facts.userID == self.access.profileID,
                  facts.role == "operator",
                  current
            else { throw PersonalInstructionsError.connectionChanged }
            // The Gateway revalidates the person's live role and agent access at the write.
            let data = try await session.request(
                method: "users.personalFile.set",
                paramsJSON: Self.paramsJSON(agentID: self.agentID, content: self.draft, hash: file.hash),
                ifCurrentRoute: self.access.route)
            let updated = try decode(data)
            guard self.current, !Task.isCancelled else { return }
            self.file = updated
            self.draft = updated.content
            self.saved = true
        } catch {
            guard self.current, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    private func decode(_ data: Data) throws -> NativePersonalFile {
        let result = try JSONDecoder().decode(NativePersonalFile.self, from: data)
        guard result.agentId == self.agentID, result.profileId == self.access.profileID else {
            throw PersonalInstructionsError.connectionChanged
        }
        return result
    }

    private static func paramsJSON(agentID: String, content: String? = nil, hash: String? = nil) throws -> String {
        var params: [String: Any] = ["agentId": agentID]
        if let content {
            params["content"] = content
            params["expectedHash"] = hash.map { $0 as Any } ?? NSNull()
        }
        guard let value = try String(bytes: JSONSerialization.data(withJSONObject: params), encoding: .utf8)
        else { throw CocoaError(.fileWriteInapplicableStringEncoding) }
        return value
    }
}

private enum PersonalInstructionsError: LocalizedError {
    case connectionChanged

    var errorDescription: String? {
        "Your profile or connection changed. Return to Settings to reopen personal instructions."
    }
}
