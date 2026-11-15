import Foundation
import OpenClawChatUI

extension MacGatewayChatTransport: OpenClawChatSidebarHoverTransport {
    @MainActor var sidebarHoverFacts: OpenClawChatSidebarHoverFacts {
        MacGatewaySidebarHoverFacts.facts(for: self)
    }

    @MainActor func sidebarHoverChannelAvatar(
        session: OpenClawChatSessionEntry, sessionAgentID: String?) async -> Data?
    {
        await self.sidebarAvatar(
            session: session, sessionAgentID: sessionAgentID, resource: .channel, advertised: session.channelAvatarUrl)
    }

    @MainActor func sidebarHoverAgentAvatar(
        session: OpenClawChatSessionEntry, sessionAgentID: String?, agentID: String, advertised: String) async -> Data?
    {
        await self.sidebarAvatar(
            session: session, sessionAgentID: sessionAgentID, resource: .agent(agentID), advertised: advertised)
    }

    @MainActor private func sidebarAvatar(
        session: OpenClawChatSessionEntry,
        sessionAgentID: String?,
        resource: OpenClawChatSidebarHoverFacts.AvatarResource,
        advertised: String?) async -> Data?
    {
        let path: String
        let id: String
        switch resource {
        case .channel: (path, id) = ("__openclaw__/channel-avatar", session.key)
        case let .agent(agentID): (path, id) = ("avatar", agentID)
        }
        guard await (try? self.requireCurrentOutboxGateway()) != nil,
              let lease = await self.connection.captureServerLease(),
              let base = try? GatewayEndpointStore.dashboardURL(
                  for: (url: lease.route.url, token: nil, password: nil), mode: .remote),
              var url = URLComponents(
                  url: base.appending(path: path).appending(component: id),
                  resolvingAgainstBaseURL: false) else { return nil }
        if case .agent = resource {
            guard let advertised, let route = URL(string: advertised, relativeTo: base)?.absoluteURL,
                  route.scheme == base.scheme, route.host == base.host, route.port == base.port,
                  route.path == url.path else { return nil }
        }
        // control-ui-resource-routes.ts:92: construct the authenticated route; never send credentials to an advertised host.
        url.queryItems = advertised.flatMap(URLComponents.init(string:))?.queryItems?
            .filter { $0.name == "v" }
        guard let targetURL = url.url else { return nil }
        let revision = await self.connection.sourceResourceRevision
        let data = await self.sidebarHoverFacts.avatar(
            sessionKey: session.key,
            agentID: sessionAgentID,
            version: "\(targetURL.absoluteString)#\(revision)",
            resource: resource)
        {
            guard let (data, response) = try? await self.connection.requestSourceResource(
                url: targetURL, maximumBytes: 2 * 1024 * 1024, lease: lease, revision: revision)
            else { return .unavailable }
            if (response as? HTTPURLResponse)?.statusCode == 404 { return .notFound }
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  response.mimeType?.hasPrefix("image/") == true else { return .unavailable }
            return .image(data)
        }
        guard await self.connection.isCurrentServerLease(lease),
              await self.connection.sourceResourceRevision == revision else { return nil }
        return data
    }
}

@MainActor private final class MacGatewaySidebarHoverFacts {
    private struct WeakFacts { weak var value: OpenClawChatSidebarHoverFacts? }
    private static var sources: [ObjectIdentifier: WeakFacts] = [:]
    private let transport: MacGatewayChatTransport
    private weak var facts: OpenClawChatSidebarHoverFacts?
    private var task: Task<Void, Never>?
    private var lease: GatewayConnection.ServerLease?

    private init(_ transport: MacGatewayChatTransport) {
        self.transport = transport
    }

    static func facts(for transport: MacGatewayChatTransport) -> OpenClawChatSidebarHoverFacts {
        self.sources = self.sources.filter { $0.value.value != nil }
        let key = ObjectIdentifier(transport.connection)
        if let facts = self.sources[key]?.value { return facts }
        let source = Self(transport)
        let facts = OpenClawChatSidebarHoverFacts { active in source.setActive(active) }
        source.facts = facts
        self.sources[key] = WeakFacts(value: facts)
        return facts
    }

    private func setActive(_ active: Bool) {
        if !active {
            self.task?.cancel()
            self.task = nil
            self.lease = nil
            self.facts?.disconnect()
            return
        }
        guard self.task == nil else { return }
        let connection = self.transport.connection
        self.task = Task { [weak self] in
            for await delivery in await connection.subscribe() {
                guard !Task.isCancelled, let self else { return }
                if case .disconnected = delivery.event, self.lease == delivery.serverLease {
                    self.lease = nil
                    self.facts?.disconnect()
                }
                guard delivery.isCurrent, let push = delivery.push else { continue }
                switch push {
                case .snapshot:
                    self.facts?.disconnect()
                    guard await (try? self.transport.requireCurrentOutboxGateway()) != nil,
                          delivery.isCurrent else { continue }
                    let lease = delivery.serverLease
                    self.lease = lease
                    let advertised = await connection.supportsServerMethod(
                        "controlUi.sessionPullRequests.subscribe", ifCurrentServerLease: lease) == true
                    guard delivery.isCurrent else { continue }
                    self.facts?.connect(request: { request in
                        try await connection.request(request, ifCurrentServerLease: lease)
                    }, pullRequestsAvailable: advertised)
                case let .event(event):
                    guard [
                        "controlUi.sessionPullRequests.changed",
                        "progressCard.changed",
                        "sessions.changed",
                        "agent",
                        "session.tool",
                    ].contains(event.event) else { continue }
                    if let payload = event.payload, let data = try? JSONEncoder().encode(payload) {
                        self.facts?.receive(event: event.event, payload: data)
                    }
                case .seqGap: self.facts?.refresh()
                }
            }
        }
    }
}
