import CryptoKit
import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

/// A local presentation reference. The Gateway session and board remain authoritative.
struct LobbySessionReferenceStore {
    let defaults: UserDefaults

    static func scope(gatewayID: String, principal: String?, credential: String, deviceProfile: String) -> String {
        let identity = principal.map { "principal:\($0)" } ?? "credential:\(credential)|\(deviceProfile)"
        let payload = ["lobby-v1", gatewayID, identity].map { "\($0.utf8.count):\($0)" }.joined()
        return SHA256.hash(data: Data(payload.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func key(_ scope: String) -> String {
        "lobby.reference.\(scope)"
    }

    func existing(scope: String) -> String? {
        guard let value = self.defaults.string(forKey: self.key(scope)),
              OpenClawChatSessionKey.agentID(from: value) != nil,
              value.contains(":lobby-")
        else { return nil }
        return value
    }

    func reserve(scope: String, agentID: String, makeID: () -> UUID = UUID.init) -> String {
        if let existing = self.existing(scope: scope) { return existing }
        let sessionKey = "agent:\(agentID):lobby-\(makeID().uuidString.lowercased())"
        // Persist before dispatch: an uncertain create can be adopted using the same key.
        self.defaults.set(sessionKey, forKey: self.key(scope))
        return sessionKey
    }

    func isConfirmed(scope: String) -> Bool {
        self.defaults.bool(forKey: self.key(scope) + ".confirmed")
    }

    func confirm(scope: String) {
        self.defaults.set(true, forKey: self.key(scope) + ".confirmed")
    }
}

/// Uses the existing session writer; no Lobby registry or second lifecycle policy.
enum LobbySessionPreparation {
    typealias Request = @MainActor (_ method: String, _ params: [String: AnyCodable]) async throws -> Data

    @MainActor static func prepare(
        key: String,
        agentID: String,
        request: Request,
        isCurrent: () -> Bool) async throws
    {
        guard isCurrent() else { throw CancellationError() }
        let data = try await request("sessions.create", [
            "key": AnyCodable(key), "agentId": AnyCodable(agentID),
            "displayName": AnyCodable("Lobby"), "visibility": AnyCodable(SessionVisibility.draft.rawValue),
        ])
        guard isCurrent() else { throw CancellationError() }
        let response = try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data)
        guard response.key == key else {
            throw NSError(domain: "Lobby", code: 1, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "The Gateway returned a different Lobby conversation."),
            ])
        }
        _ = try await request("sessions.patch", [
            "key": AnyCodable(key), "boardFace": AnyCodable("dashboard"),
            "boardPresentation": AnyCodable("expanded"),
        ])
        guard isCurrent() else { throw CancellationError() }
    }
}

enum LobbyComponentConversationPreparation {
    struct Reference: Decodable {
        let key: String
        let title: String
    }

    @MainActor static func prepare(
        parentKey: String,
        agentID: String,
        selection: LobbyComponentSelection,
        request: LobbySessionPreparation.Request,
        isCurrent: () -> Bool) async throws -> Reference
    {
        guard isCurrent() else { throw CancellationError() }
        let data = try await request("board.widget.conversation", [
            "sessionKey": AnyCodable(parentKey), "agentId": AnyCodable(agentID),
            "name": AnyCodable(selection.name), "instanceId": AnyCodable(selection.instanceID),
        ])
        guard isCurrent() else { throw CancellationError() }
        let reference = try JSONDecoder().decode(Reference.self, from: data)
        let prefix = NSRegularExpression.escapedPattern(for: "\(parentKey):component:\(selection.name):")
        guard reference.key.range(of: "^\(prefix)[a-f0-9]{32}$", options: .regularExpression) != nil else {
            throw NSError(domain: "Lobby", code: 2, userInfo: [NSLocalizedDescriptionKey:
                    String(localized: "The Gateway returned a different component conversation.")])
        }
        let created = try await request("sessions.create", [
            "key": AnyCodable(reference.key), "agentId": AnyCodable(agentID),
            "parentSessionKey": AnyCodable(parentKey), "fork": AnyCodable(false),
            "displayName": AnyCodable(reference.title), "visibility": AnyCodable(SessionVisibility.draft.rawValue),
        ])
        guard isCurrent() else { throw CancellationError() }
        let response = try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: created)
        guard response.key == reference.key else {
            throw NSError(domain: "Lobby", code: 2, userInfo: [NSLocalizedDescriptionKey:
                    String(localized: "The Gateway returned a different component conversation.")])
        }
        return reference
    }
}

@MainActor
@Observable
final class LobbyModel {
    private(set) var sessionKey: String?
    private(set) var ownerAgentID: String?
    private(set) var viewModel: OpenClawChatViewModel?
    private(set) var conversationViewModel: OpenClawChatViewModel?
    private(set) var conversationTitle = String(localized: "Lobby conversation")
    private(set) var isPreparingConversation = false
    private(set) var isPreparing = false
    private(set) var errorText: String?
    private(set) var presentationID = UUID()
    @ObservationIgnored private let references: LobbySessionReferenceStore
    @ObservationIgnored private var scope: String?
    @ObservationIgnored private var authority: GatewayConnectConfig.ControlUIInputs?
    @ObservationIgnored private var hydrationTask: Task<Bool, Never>?
    @ObservationIgnored private var componentConversations: [String: OpenClawChatViewModel] = [:]
    @ObservationIgnored private var isHandlingComponentPrompt = false

    init(defaults: UserDefaults = .standard) {
        self.references = LobbySessionReferenceStore(defaults: defaults)
    }

    var isWorking: Bool {
        self.isPreparing || self.viewModel?.isSubmittingDraft == true || self.viewModel?.isSending == true ||
            (self.viewModel?.pendingRunCount ?? 0) > 0
    }

    func sync(appModel: NodeAppModel) {
        let config = appModel.activeGatewayConnectConfig
        let nextScope = config.map {
            LobbySessionReferenceStore.scope(
                gatewayID: $0.effectiveStableID,
                principal: $0.ingressAuthorization?.principal.fingerprint,
                credential: AuthenticatedControlUI.storedOperatorToken(config: $0) ?? $0.token ?? $0.password ?? "",
                deviceProfile: $0.nodeOptions.deviceIdentityProfile.rawValue)
        }
        guard nextScope != self.scope || config?.controlUIInputs != self.authority else {
            if appModel.isOperatorGatewayConnected, self.viewModel == nil { self.installModel(appModel: appModel) }
            self.viewModel?.syncSessionRoutingContract(appModel.chatSessionRoutingContract)
            return
        }
        self.viewModel?.detachTransport()
        self.componentConversations.values.forEach { $0.detachTransport() }
        self.componentConversations = [:]
        self.conversationViewModel = nil
        self.isPreparingConversation = false
        self.isHandlingComponentPrompt = false
        self.hydrationTask?.cancel()
        self.hydrationTask = nil
        self.viewModel = nil
        self.scope = nextScope
        self.authority = config?.controlUIInputs
        self.presentationID = UUID()
        self.isPreparing = false
        self.errorText = nil
        self.sessionKey = nextScope
            .flatMap { self.references.isConfirmed(scope: $0) ? self.references.existing(scope: $0) : nil }
        self.ownerAgentID = self.sessionKey.flatMap(OpenClawChatSessionKey.agentID(from:))
        if appModel.isOperatorGatewayConnected { self.installModel(appModel: appModel) }
    }

    private func installModel(appModel: NodeAppModel) {
        guard let sessionKey, let ownerAgentID else { return }
        let transport = IOSGatewayChatTransport(
            gateway: appModel.operatorSession,
            globalAgentId: ownerAgentID,
            outboxGatewayID: appModel.activeGatewayConnectConfig?.effectiveStableID)
        let viewModel = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: ownerAgentID,
            sessionRoutingContract: appModel.chatSessionRoutingContract)
        self.viewModel = viewModel
        self.hydrationTask = Task { await viewModel.loadAndWait() }
    }

    func acceptComponentPrompt(
        _ prompt: LobbyComponentPrompt,
        selection: LobbyComponentSelection?,
        presentationID: UUID,
        appModel: NodeAppModel) async -> Bool
    {
        guard self.presentationID == presentationID, prompt.isCurrent(),
              !self.isPreparingConversation, !self.isHandlingComponentPrompt,
              appModel.isOperatorGatewayConnected, let authority = self.authority,
              authority == appModel.activeGatewayConnectConfig?.controlUIInputs,
              let route = await appModel.operatorSession.currentRoute()
        else { return false }
        let isCurrent = {
            self.presentationID == presentationID && prompt.isCurrent() &&
                self.authority == authority && appModel.isOperatorGatewayConnected &&
                appModel.activeGatewayConnectConfig?.controlUIInputs == authority && !Task.isCancelled
        }
        guard isCurrent(), !self.isHandlingComponentPrompt else { return false }
        self.isHandlingComponentPrompt = true
        defer { if self.presentationID == presentationID { self.isHandlingComponentPrompt = false } }
        let target: OpenClawChatViewModel
        if let selection {
            guard await self.openConversation(selection: selection, appModel: appModel),
                  isCurrent(), let viewModel = self.conversationViewModel else { return false }
            target = viewModel
        } else {
            guard !self.isWorking, let viewModel, !viewModel.isLoading,
                  viewModel.sessionKey == self.sessionKey else { return false }
            target = viewModel
        }
        do {
            // Reuse the Gateway's live ticket check after all conversation preparation.
            // Removal, replacement and grant changes retire the originating ticket.
            let data = try await appModel.operatorSession.request(
                method: "board.prompt.authorize",
                params: ["ticket": AnyCodable(prompt.ticket)],
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            struct Authorization: Decodable { let confirmationRequired: Bool }
            _ = try JSONDecoder().decode(Authorization.self, from: data)
            // The host already performed any required confirmation before handing off
            // this exact ticket. No await separates this check from normal chat custody.
            guard isCurrent(), target.composerModelAvailabilityMessage == nil else { return false }
            let accepted = Self.sendComponentPrompt(prompt.text, to: target)
            if !accepted {
                self.errorText = target.errorText ?? String(localized:
                    "Finish or clear the current conversation draft, then try again.")
            }
            return accepted
        } catch {
            if isCurrent() { self.errorText = error.localizedDescription }
            return false
        }
    }

    func openConversation(selection: LobbyComponentSelection?, appModel: NodeAppModel) async -> Bool {
        if selection == nil {
            let prepared = self.viewModel != nil ? self.viewModel : await self.prepareConversation(appModel: appModel)
            guard let viewModel = prepared else { return false }
            self.conversationViewModel = viewModel
            self.conversationTitle = String(localized: "Lobby conversation")
            return true
        }
        guard let selection, !self.isPreparingConversation, let parentKey = self.sessionKey,
              let agentID = self.ownerAgentID, let authority, appModel.isOperatorGatewayConnected,
              let route = await appModel.operatorSession.currentRoute() else { return false }
        let presentationID = self.presentationID
        guard !self.isPreparingConversation, self.sessionKey == parentKey, self.authority == authority,
              appModel.activeGatewayConnectConfig?.controlUIInputs == authority else { return false }
        self.isPreparingConversation = true
        self.errorText = nil
        defer { if self.presentationID == presentationID { self.isPreparingConversation = false } }
        let isCurrent = {
            self.presentationID == presentationID && self.authority == authority &&
                appModel.activeGatewayConnectConfig?.controlUIInputs == authority && !Task.isCancelled
        }
        do {
            let reference = try await LobbyComponentConversationPreparation.prepare(
                parentKey: parentKey,
                agentID: agentID,
                selection: selection,
                request: { method, params in
                    try await appModel.operatorSession.request(
                        method: method,
                        params: params,
                        ifCurrentRoute: route,
                        distinguishPreDispatchRouteChange: true)
                }, isCurrent: isCurrent)
            guard isCurrent() else { throw CancellationError() }
            let viewModel: OpenClawChatViewModel
            if let existing = self.componentConversations[reference.key] {
                viewModel = existing
            } else {
                viewModel = OpenClawChatViewModel(
                    sessionKey: reference.key,
                    transport: IOSGatewayChatTransport(
                        gateway: appModel.operatorSession,
                        globalAgentId: agentID,
                        outboxGatewayID: appModel.activeGatewayConnectConfig?
                            .effectiveStableID),
                    activeAgentId: agentID,
                    sessionRoutingContract: appModel.chatSessionRoutingContract)
                self.componentConversations[reference.key] = viewModel
            }
            let ready = await viewModel.loadAndWait()
            guard isCurrent() else { throw CancellationError() }
            guard ready else {
                self.errorText = viewModel.errorText ?? String(localized:
                    "Unable to load this component conversation. Check the Gateway connection and try again.")
                return false
            }
            self.conversationViewModel = viewModel
            self.conversationTitle = reference.title
            return true
        } catch is CancellationError {
            return false
        } catch {
            if isCurrent() { self.errorText = error.localizedDescription }
            return false
        }
    }

    static func sendComponentPrompt(_ text: String, to viewModel: OpenClawChatViewModel) -> Bool {
        guard viewModel.input.isEmpty, viewModel.attachments.isEmpty, viewModel.replyTarget == nil,
              !viewModel.isSending, !viewModel.isSubmittingDraft, viewModel.pendingRunCount == 0 else { return false }
        // Admit a component request only when its normal conversation composer has no pending draft.
        viewModel.input = text
        guard viewModel.send() != nil else {
            viewModel.input = ""
            return false
        }
        return true
    }

    private func prepareConversation(appModel: NodeAppModel) async -> OpenClawChatViewModel? {
        guard !self.isWorking, appModel.isOperatorGatewayConnected,
              let scope, let authority,
              let route = await appModel.operatorSession.currentRoute()
        else { return nil }
        guard !self.isWorking, self.scope == scope, self.authority == authority,
              appModel.activeGatewayConnectConfig?.controlUIInputs == authority
        else { return nil }
        let presentationID = self.presentationID
        self.isPreparing = true
        self.errorText = nil
        defer { if self.presentationID == presentationID { self.isPreparing = false } }
        do {
            if self.sessionKey == nil {
                let agentID = appModel.chatAgentId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard !agentID.isEmpty else { throw CancellationError() }
                let key = self.references.reserve(scope: scope, agentID: agentID)
                let owner = OpenClawChatSessionKey.agentID(from: key) ?? agentID
                try await LobbySessionPreparation.prepare(
                    key: key,
                    agentID: owner,
                    request: { method, params in
                        try await appModel.operatorSession.request(
                            method: method,
                            params: params,
                            ifCurrentRoute: route,
                            distinguishPreDispatchRouteChange: true)
                    },
                    isCurrent: {
                        self.presentationID == presentationID && self.scope == scope && self.authority == authority &&
                            appModel.activeGatewayConnectConfig?.controlUIInputs == authority && !Task.isCancelled
                    })
                self.references.confirm(scope: scope)
                self.sessionKey = key
                self.ownerAgentID = owner
                self.installModel(appModel: appModel)
            }
            guard let viewModel = self.viewModel,
                  self.presentationID == presentationID, self.scope == scope, self.authority == authority
            else { throw CancellationError() }
            if self.hydrationTask == nil {
                self.hydrationTask = Task { await viewModel.loadAndWait() }
            }
            let ready = await self.hydrationTask?.value == true
            guard self.presentationID == presentationID, self.scope == scope, self.authority == authority,
                  appModel.activeGatewayConnectConfig?.controlUIInputs == authority,
                  self.viewModel === viewModel, !Task.isCancelled
            else { throw CancellationError() }
            guard ready else {
                self.hydrationTask = nil
                self.errorText = viewModel.composerModelAvailabilityMessage ?? viewModel.errorText ?? String(localized:
                    "Unable to load your Lobby conversation. Check the Gateway connection and try again.")
                return nil
            }
            return viewModel
        } catch is CancellationError {
            // Never apply a retired preparation to another Gateway.
        } catch {
            guard self.presentationID == presentationID, self.scope == scope,
                  self.authority == authority else { return nil }
            self.errorText = error.localizedDescription
        }
        return nil
    }
}
