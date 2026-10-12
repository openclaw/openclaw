import Foundation
import OpenClawChatUI
import OpenClawKit

extension MacGatewayChatTransport: OpenClawSidebarCatalogTransport {
    @MainActor
    func catalogEvents() async -> AsyncStream<OpenClawSidebarCatalogEvent> {
        AsyncStream { continuation in
            let task = Task { @MainActor in
                var observedLease: GatewayConnection.ServerLease?
                var changedEvents = false
                for await delivery in await self.connection.subscribe() {
                    guard !Task.isCancelled else { break }
                    if case .disconnected = delivery.event, observedLease == delivery.serverLease {
                        observedLease = nil
                        changedEvents = false
                        continuation.yield(.disconnected)
                    }
                    guard delivery.isCurrent, let push = delivery.push else { continue }
                    switch push {
                    case let .snapshot(hello):
                        observedLease = delivery.serverLease
                        changedEvents = false
                        let methods = hello.advertisedServerMethods() ?? []
                        let scopes = hello.advertisedOperatorScopes() ?? []
                        guard methods.contains("sessions.catalog.list"),
                              !scopes.isDisjoint(with: ["operator.read", "operator.write", "operator.admin"]),
                              await self.currentOutboxGatewayMatchesConnection(),
                              !Task.isCancelled, delivery.isCurrent
                        else {
                            continuation.yield(.unavailable)
                            continue
                        }
                        changedEvents = hello.features["events"]?.arrayValue?.contains {
                            $0.stringValue == "sessions.catalog.changed"
                        } == true
                        let lease = delivery.serverLease
                        let primaryScope = self.connection === GatewayConnection.shared
                            ? MacChatTranscriptCache.currentGatewayID() : nil
                        let profileID = self.outboxGatewayID ??
                            primaryScope ??
                            lease.route.browserSession?.chatStoreID(profileID: lease.route.url.absoluteString) ??
                            lease.route.url.absoluteString
                        continuation.yield(.connected(OpenClawSidebarCatalogConnection(
                            profileID: profileID,
                            changedEvents: changedEvents,
                            allowsArchive: methods.contains("sessions.catalog.archive") &&
                                !scopes.isDisjoint(with: ["operator.write", "operator.admin"]),
                            request: { request in
                                try await self.connection.request(request, ifCurrentServerLease: lease)
                            },
                            isCurrent: { self.connection.serverLeaseMatchesCurrentState(lease) },
                            openSources: { self.openCatalogSources(lease: lease) })))
                    case let .event(event) where changedEvents && event.event == "sessions.catalog.changed":
                        continuation.yield(.changed(event.payload?.dictionaryValue?["agentId"]?.stringValue))
                    default: break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    @MainActor
    private func openCatalogSources(lease: GatewayConnection.ServerLease) {
        Task { @MainActor in
            guard self.connection.serverLeaseMatchesCurrentState(lease),
                  let target = await self.catalogDashboardTarget(),
                  self.connection.serverLeaseMatchesCurrentState(lease)
            else { return }
            // ui/src/pages/config/route-data.ts:29; the native Dashboard handoff supports path/query only.
            await DashboardManager.shared.show(
                atPath: DashboardRouteMap.appearanceSettingsPath,
                search: "?section=__appearance__",
                target: target,
                ifCurrent: { self.connection.serverLeaseMatchesCurrentState(lease) })
        }
    }

    private func catalogDashboardTarget() async -> DashboardGatewayTarget? {
        if self.connection === GatewayConnection.shared { return .primary }
        let fleet = MacGatewayConnectionFleet.shared
        if await fleet.existingLocalConnection() === self.connection { return .local }
        for profileID in await fleet.boundProfileIDs()
            where await fleet.existingConnection(profileID: profileID) === self.connection
        {
            return .profile(profileID)
        }
        return nil
    }
}
