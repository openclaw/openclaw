import Foundation
import OpenClawProtocol

/// Hello facts and the viewer's profile belong to one admitted socket, including reconnects.
public struct GatewayReactionAccessFacts: Sendable {
    public let routeID: UUID
    public let role: String?
    public let scopes: Set<String>?
    public let sessionCap: String?
    public let methods: Set<String>?
    public internal(set) var userID: String?

    init(hello: HelloOk) {
        self.routeID = UUID()
        self.role = hello.auth["role"]?.stringValue
        self.scopes = hello.advertisedOperatorScopes()
        self.sessionCap = hello.auth["sessionCap"]?.stringValue
        self.methods = hello.advertisedServerMethods()
        if let connectionID = hello.server["connId"]?.stringValue,
           let presence = hello.snapshot.presence.first(where: {
               $0.connectionid == connectionID && $0.reason != "disconnect"
           }),
           let identity = presence.user?["identity"]?.dictionaryValue,
           identity["type"]?.stringValue == "profile"
        {
            self.userID = identity["id"]?.stringValue
        }
    }
}

extension GatewayNodeSession {
    public func currentReactionAccess(ifCurrentRoute route: GatewayNodeSessionRoute) async
        -> GatewayReactionAccessFacts?
    {
        guard await self.currentRoute() == route, let access = self.reactionAccess else { return nil }
        guard access.userID == nil, access.methods?.contains("users.self") == true else { return access }
        struct SelfProfile: Decodable {
            struct Profile: Decodable { let id: String }
            let profile: Profile
        }
        // Session-only operators may have no presence row. The same users.self owner as the
        // Control UI supplies their immutable profile; retain successful reads until disconnect.
        let data = try? await self.request(method: "users.self", params: [:], ifCurrentRoute: route)
        guard await self.currentRoute() == route, self.reactionAccess?.routeID == access.routeID else { return nil }
        if let data, let profile = try? JSONDecoder().decode(SelfProfile.self, from: data) {
            self.reactionAccess?.userID = profile.profile.id
        }
        return self.reactionAccess
    }
}
