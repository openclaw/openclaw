import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

@MainActor
final class MacGatewaySidebarPresence {
    let people = OpenClawChatSidebarPeople()
    private let connection: GatewayConnection
    private let target: DashboardGatewayTarget
    private var lease: GatewayConnection.ServerLease?
    private var task: Task<Void, Never>?
    private var countsTask: Task<Void, Never>?
    private var countsDirty = false
    private var subscribedLease: GatewayConnection.ServerLease?
    private var recoveryTask: Task<Void, Never>?
    private var activityTask: Task<Void, Never>?

    init(connection: GatewayConnection, target: DashboardGatewayTarget) {
        self.connection = connection
        self.target = target
    }

    var actions: OpenClawSidebarPeopleActions {
        OpenClawSidebarPeopleActions(
            retry: { [weak self] in
                guard let self else { return }
                if self.people.presenceFailed {
                    self.resynchronizePresence()
                } else {
                    self.refreshCounts()
                }
            },
            activity: { [weak self] id, _ in
                guard let self, let lease = self.lease else { return }
                guard let path = OpenClawChatSidebarPeople.activityPath(for: id) else { return }
                Task {
                    await DashboardManager.shared.show(atPath: path, target: self.target) {
                        self.lease == lease && self.connection.serverLeaseMatchesCurrentState(lease)
                    }
                }
            },
            avatar: { [weak self] id, url in
                guard let self, let lease = self.lease else { return nil }
                return await self.connection.sidebarAvatar(profileID: id, advertised: url, lease: lease)
            })
    }

    func start() {
        guard self.task == nil else { return }
        self.task = Task { [weak self, connection] in
            for await delivery in await connection.subscribe() {
                guard !Task.isCancelled, let self else { return }
                if case .disconnected = delivery.event, self.lease == delivery.serverLease {
                    self.retirePresence()
                }
                guard delivery.isCurrent, let push = delivery.push else { continue }
                switch push {
                case let .snapshot(hello):
                    self.retirePresence()
                    self.lease = delivery.serverLease
                    self.people.receive(hello)
                    // GatewayConnection.subscribe replays its original hello to a new window.
                    // Refresh the live roster; later presence events supersede this recovery read.
                    self.resynchronizePresence()
                case let .event(event) where event.event == "presence":
                    if let payload = event.payload, let data = try? JSONEncoder().encode(payload),
                       (try? self.people.receivePresence(data)) == true { self.refreshCounts() }
                    self.scheduleActivity()
                case let .event(event) where event.event == "sessions.changed": self.refreshCounts()
                case .seqGap: self.resynchronizePresence()
                default: break
                }
            }
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
        self.retirePresence()
    }

    private func retirePresence() {
        self.countsTask?.cancel()
        self.countsTask = nil
        self.countsDirty = false
        self.subscribedLease = nil
        self.recoveryTask?.cancel()
        self.activityTask?.cancel()
        self.lease = nil
        self.people.disconnect()
    }

    private func resynchronizePresence() {
        guard let lease = self.lease else { return }
        self.recoveryTask?.cancel()
        self.activityTask?.cancel()
        self.recoveryTask = Task {
            await self.people.resynchronizePresence {
                try await self.connection.request(method: "system-presence", params: nil, ifCurrentServerLease: lease)
            }
            guard !Task.isCancelled, self.lease == lease else { return }
            self.scheduleActivity()
            self.refreshCounts()
        }
    }

    private func scheduleActivity() {
        self.activityTask?.cancel()
        let now = Date.now
        self.people.refreshActivity(at: now)
        guard let deadline = self.people.nextActivityDeadline(after: now) else { return }
        // ui/src/lit/presence-activity-controller.ts:8: expiry is a local presentation refresh, not network polling.
        self.activityTask = Task {
            do {
                try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
            } catch {
                return
            }
            self.scheduleActivity()
        }
    }

    private func refreshCounts() {
        guard let lease = self.lease else { return }
        self.countsDirty = true
        guard self.countsTask == nil else { return }
        self.countsTask = Task {
            // Coalesce event bursts into one trailing read without starving an in-flight facet.
            while !Task.isCancelled, self.lease == lease, self.countsDirty {
                self.countsDirty = false
                await self.people.refreshCounts {
                    if self.subscribedLease != lease {
                        _ = try await self.connection.request(
                            method: "sessions.subscribe", params: nil, ifCurrentServerLease: lease)
                        guard self.lease == lease, self.connection.serverLeaseMatchesCurrentState(lease) else {
                            throw CancellationError()
                        }
                        self.subscribedLease = lease
                    }
                    let data = try await self.connection.request(
                        OpenClawChatSidebarPeople.ownerCountsRequest, ifCurrentServerLease: lease)
                    guard self.lease == lease, self.connection.serverLeaseMatchesCurrentState(lease) else {
                        throw CancellationError()
                    }
                    return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
                        .ownerSessionCounts
                }
            }
            if !Task.isCancelled, self.lease == lease { self.countsTask = nil }
        }
    }
}

extension GatewayConnection {
    func sidebarAvatar(profileID: String, advertised: String?, lease: ServerLease) async -> Data? {
        guard self.serverLeaseMatchesCurrentState(lease),
              let base = try? GatewayEndpointStore.dashboardURL(
                  for: (url: lease.route.url, token: nil, password: nil), mode: .remote),
              var url = URLComponents(
                  url: base.appending(path: "api/users").appending(component: profileID)
                      .appending(path: "avatar"),
                  resolvingAgainstBaseURL: false) else { return nil }
        // ui/src/lib/identity-avatar.ts:113: avatars stay on the connected Gateway, including their authentication.
        url.queryItems = advertised.flatMap(URLComponents.init(string:))?.queryItems?.filter { $0.name == "v" }
        guard let resource = url.url,
              let (data, response) = try? await self.requestSourceResource(
                  url: resource, maximumBytes: 2 * 1024 * 1024, lease: lease, revision: self.sourceResourceRevision),
              (response as? HTTPURLResponse)?.statusCode == 200,
              response.mimeType?.hasPrefix("image/") == true else { return nil }
        return data
    }
}
