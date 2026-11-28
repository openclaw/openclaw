import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

/// Personal Pinned placements, in the desktop's saved order. Rail shortcuts, pages and people are not chat pins.
struct IOSSidebarPins: Equatable {
    static let preferenceKey = "ui.railShortcuts"
    private static let defaultEntries = ["route:cron", "route:plugins", "route:usage"]
    let positions: [String: Int]

    init(entries: [String] = []) {
        self.positions = Dictionary(entries.enumerated().compactMap { index, entry in
            guard entry.hasPrefix("session:"), let key = String(entry.dropFirst(8)).trimmedNonEmpty else { return nil }
            return (key, index)
        }, uniquingKeysWith: min)
    }

    func project(_ session: OpenClawChatSessionEntry) -> OpenClawChatSessionEntry {
        var row = session
        row.pinned = self.positions[row.key] != nil
        row.pinnedAt = nil // Session-wide metadata is not this profile's placement.
        return row
    }

    typealias Request = @MainActor (OpenClawChatGatewayRequest) async throws -> Data

    @MainActor static func read(using request: Request) async throws -> [String]? {
        struct Reply: Decodable {
            let status: String
            let entries: [String: [String]]?
        }
        let data = try await request(.init(
            method: "users.prefs.get",
            params: ["keys": .init([self.preferenceKey])],
            timeoutMs: 8000))
        let reply = try JSONDecoder().decode(Reply.self, from: data)
        guard reply.status == "ok", let entries = reply.entries else { throw CocoaError(.featureUnsupported) }
        return entries[self.preferenceKey]
    }

    /// Change one reference, never overwrite another client's placement or replace unrelated shortcuts.
    @MainActor static func set(_ key: String, pinned: Bool, using request: Request) async throws -> Self {
        struct Reply: Decodable { let status: String }
        for attempt in 0...1 {
            let stored = try await self.read(using: request)
            var entries = stored ?? self.defaultEntries
            let ref = "session:\(key)"
            guard entries.contains(ref) != pinned else { return Self(entries: entries) }
            if pinned { entries.append(ref) } else { entries.removeAll { $0 == ref } }
            let expected: AnyCodable = stored.map(AnyCodable.init) ?? .init(NSNull())
            let data = try await request(.init(
                method: "users.prefs.set",
                params: [
                    "entries": .init([self.preferenceKey: entries]),
                    "expectedEntries": .init([self.preferenceKey: expected]),
                ],
                timeoutMs: 8000))
            switch try JSONDecoder().decode(Reply.self, from: data).status {
            case "ok": return Self(entries: entries)
            case "conflict" where attempt == 0: continue
            case "conflict": throw CocoaError(.fileWriteFileExists)
            default: throw CocoaError(.featureUnsupported)
            }
        }
        throw CocoaError(.fileWriteUnknown)
    }
}

extension NodeAppModel {
    /// Only the synthetic transport still models pins as session fields.
    var displayedSidebarPins: IOSSidebarPins? {
        self.isLocalChatFixtureEnabled ? nil : self.personalSidebarPins
    }

    func refreshPersonalSidebarPins() async {
        guard let gatewayID = self.chatTranscriptCacheGatewayID,
              let route = await self.operatorSession.currentRoute(ifGatewayID: gatewayID) else { return }
        do {
            let entries = try await IOSSidebarPins.read {
                try await self.operatorSession.request($0, ifCurrentRoute: route)
            }
            guard await self.operatorSession.currentRoute(ifGatewayID: gatewayID) == route else { return }
            self.personalSidebarPins = IOSSidebarPins(entries: entries ?? [])
        } catch {
            // A failed read must not erase this connection's last confirmed order.
        }
    }

    func setPersonalSidebarPin(_ key: String, pinned: Bool) async throws {
        if self.isLocalChatFixtureEnabled {
            try await self.makeChatTransport().patchSession(
                key: key,
                expectedSessionID: nil,
                label: nil,
                category: nil,
                color: nil,
                pinned: pinned,
                archived: nil,
                unread: nil)
            return
        }
        guard let gatewayID = self.chatTranscriptCacheGatewayID,
              let route = await self.operatorSession.currentRoute(ifGatewayID: gatewayID)
        else { throw CancellationError() }
        let confirmed = try await IOSSidebarPins.set(key, pinned: pinned) {
            try await self.operatorSession.request($0, ifCurrentRoute: route)
        }
        guard await self.operatorSession.currentRoute(ifGatewayID: gatewayID) == route
        else { throw CancellationError() }
        self.personalSidebarPins = confirmed
    }
}
