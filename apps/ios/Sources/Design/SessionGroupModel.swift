import Foundation
import Observation
import OpenClawChatUI
import OpenClawProtocol

@MainActor
@Observable
final class SessionGroupModel {
    private(set) var catalog: [OpenClawChatSessionGroup]?
    private(set) var connection: OpenClawSessionMenuConnection?
    private(set) var loading = false
    private(set) var submitting = false
    private var refreshFailure: String?
    private var mutationFailure: String?
    var failure: String? {
        self.mutationFailure ?? self.refreshFailure
    }

    private var identity: String?
    private var owner: String?
    private var generation = 0
    private var local = SessionGroupStore.load()
    var collapsed = SessionGroupStore.loadCollapsed() {
        didSet { if self.collapsed != oldValue { SessionGroupStore.saveCollapsed(self.collapsed) } }
    }

    func report(_ error: any Error) {
        self.mutationFailure = error.localizedDescription
    }

    func names(for sessions: [OpenClawChatSessionEntry]) -> [String] {
        OpenClawChatSessionGroupCatalog.names(
            catalog: self.usesCatalog ? (self.catalog ?? []) : nil, local: self.local, sessions: sessions)
    }

    func refresh(
        appModel: NodeAppModel,
        connectionProvider: (NodeAppModel) async
            -> OpenClawSessionMenuConnection? = { await $0.sessionGroupConnection() }) async
    {
        let identity = appModel.chatViewModelIdentityID
        if self.identity != identity {
            self.identity = identity
            // A dropped link is still the same Gateway: its last catalog keeps the group headers on screen.
            if self.owner != appModel.chatViewModelOwnerID {
                self.owner = appModel.chatViewModelOwnerID
                self.catalog = nil
            }
            self.connection = nil
            self.refreshFailure = nil
            self.mutationFailure = nil
        }
        self.generation += 1
        let generation = self.generation
        self.loading = true
        defer { if self.generation == generation { self.loading = false } }
        self.local = SessionGroupStore.load()
        do {
            let connection = await connectionProvider(appModel)
            guard self.generation == generation, self.identity == identity,
                  appModel.chatViewModelIdentityID == identity, !Task.isCancelled else { return }
            self.connection = connection
            guard let connection, connection.isCurrent() else { return }
            guard connection.allows("sessions.groups.list", scope: "operator.read") else {
                // A live connection without the catalog method is not a dropped link: use the device-local groups.
                self.catalog = nil
                return
            }
            let response: OpenClawChatSessionGroupsResponse = try await connection.read("sessions.groups.list")
            guard self.generation == generation, self.identity == identity,
                  appModel.chatViewModelIdentityID == identity else { return }
            var groups = response.groups
            // Match the web catalog's one-time migration: never merge into an existing Gateway catalog.
            if !self.local.isEmpty, connection.allows("sessions.groups.put") {
                if groups.isEmpty {
                    let migrated: OpenClawChatSessionGroupsMutationResponse = try await connection.read(
                        "sessions.groups.put", ["names": AnyCodable(self.local)])
                    guard self.generation == generation, self.identity == identity,
                          appModel.chatViewModelIdentityID == identity else { return }
                    groups = migrated.groups
                }
                SessionGroupStore.clear()
                self.local = []
            }
            self.catalog = groups
            self.refreshFailure = nil
        } catch is CancellationError {
            return
        } catch {
            guard self.generation == generation, appModel.chatViewModelIdentityID == identity else { return }
            self.refreshFailure = error.localizedDescription
        }
    }

    /// Forgets folded names that no longer name a group. Only against a catalog whose last refresh succeeded:
    /// a missing or stale catalog does not know the empty groups.
    func pruneCollapsed(for sessions: [OpenClawChatSessionEntry]) {
        guard self.catalog != nil, self.refreshFailure == nil else { return }
        self.collapsed.formIntersection(self.names(for: sessions))
    }

    func allows(_ method: String) -> Bool {
        !self.submitting && (method != "sessions.groups.put" || self.catalog != nil) &&
            self.connection?.allows(method) == true
    }

    var usesCatalog: Bool {
        self.catalog != nil || self.connection?.allows("sessions.groups.list", scope: "operator.read") == true
    }

    func mutate(
        appModel: NodeAppModel,
        request: OpenClawChatGatewayRequest,
        catalogNames: (([String]) -> [String])? = nil,
        fallback: @escaping (OpenClawSessionMenuConnection) async throws -> Void) async
    {
        guard let connection = self.connection, connection.isCurrent(), !self.submitting else {
            self.report(OpenClawChatTransportSendError.notDispatched)
            return
        }
        let identity = appModel.chatViewModelIdentityID
        self.submitting = true
        self.mutationFailure = nil
        self.refreshFailure = nil
        defer { self.submitting = false }
        do {
            if self.usesCatalog {
                guard connection.allows(request.method) else {
                    throw OpenClawChatTransportSendError.notDispatched
                }
                var request = request
                if request.method == "sessions.groups.put" {
                    guard self.catalog != nil, let catalogNames else {
                        throw OpenClawChatTransportSendError.notDispatched
                    }
                    // Same read-modify-write boundary as ChatViewModel.createSessionGroup.
                    let fresh: OpenClawChatSessionGroupsResponse = try await connection.read("sessions.groups.list")
                    let names = OpenClawChatSessionGroupCatalog.names(catalog: fresh.groups, local: [], sessions: [])
                    request = OpenClawChatGatewayRequests.sessionGroupsPut(names: catalogNames(names))
                }
                let response = try await JSONDecoder().decode(
                    OpenClawChatSessionGroupsMutationResponse.self, from: connection.request(request))
                guard appModel.chatViewModelIdentityID == identity else { return }
                self.catalog = response.groups
            } else {
                try await fallback(connection)
                guard appModel.chatViewModelIdentityID == identity else { return }
                self.local = SessionGroupStore.load()
            }
        } catch {
            if appModel.chatViewModelIdentityID == identity { self.report(error) }
        }
    }
}

extension NodeAppModel {
    func sessionGroupConnection() async -> OpenClawSessionMenuConnection? {
        if ScreenshotFixtureMode.groupControlsEnabled {
            return DrawerGroupFixture.connection()
        }
        guard !self.isLocalGatewayFixtureEnabled,
              let route = await self.operatorSession.currentRoute(),
              let scopes = await self.operatorSession.currentOperatorScopes(ifCurrentRoute: route)
        else { return nil }
        let candidates = [
            "sessions.groups.list", "sessions.groups.put", "sessions.groups.rename", "sessions.groups.delete",
            "sessions.groups.defaults", "sessions.groups.update", "sessions.create", "fs.listDir", "worktrees.branches",
        ]
        var methods = Set<String>()
        for method in candidates {
            guard let supported = await self.operatorSession.supportsServerMethod(method, ifCurrentRoute: route)
            else { return nil }
            if supported { methods.insert(method) }
        }
        let gateway = self.operatorSession
        guard await gateway.currentRoute() == route else { return nil }
        let identity = self.chatViewModelIdentityID
        var connection = OpenClawSessionMenuConnection(
            methods: methods,
            scopes: scopes,
            isCurrent: { [weak self] in self?.isOperatorGatewayConnected == true &&
                self?.chatViewModelIdentityID == identity
            },
            request: { request in try await gateway.request(request, ifCurrentRoute: route) })
        let captured = connection
        connection.groupDefaultsBrowser = OpenClawGroupDefaultsBrowser(
            listDirectory: { path in
                try await JSONDecoder().decode(
                    FsListDirResult.self, from: captured.request(
                        OpenClawChatGatewayRequests.groupDefaultsDirectory(path)))
            },
            inspectRepository: { path in
                let result = try await JSONDecoder().decode(
                    WorktreesBranchesResult.self, from: captured.request(
                        OpenClawChatGatewayRequests.groupDefaultsRepository(path)))
                return result.repositorystatus ?? .unavailable
            })
        return connection
    }
}
