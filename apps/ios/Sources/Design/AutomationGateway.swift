import Foundation
import OpenClawKit
import OpenClawProtocol

/// The form owns a captured operator route. Never resolve it again when Save is tapped.
struct AutomationGateway {
    typealias Params = [String: OpenClawProtocol.AnyCodable]
    let request: @MainActor (String, Params) async throws -> Data
    let canManage: Bool

    @MainActor static func connected(_ app: NodeAppModel, gatewayID: String?) async -> Self? {
        guard let gatewayID, app.isOperatorGatewayConnected,
              let route = await app.operatorSession.currentRoute(ifGatewayID: gatewayID) else { return nil }
        let session = app.operatorSession
        return Self(request: { method, params in
            try await session.request(method: method, params: params, ifCurrentRoute: route)
        }, canManage: app.hasOperatorAdminScope)
    }

    @MainActor func read<T: Decodable & Sendable>(
        _ type: T.Type,
        _ method: String,
        _ params: Params) async throws -> T
    {
        try await GatewayPayloadDecoding.decode(type, from: self.request(method, params))
    }

    struct Page: Decodable, Sendable {
        let jobs: [ChatInfoAutomation]
        let hasMore: Bool
        let nextOffset: Int?
        let snapshotRevision: String
    }

    struct Definition: Decodable, Identifiable, Sendable {
        let id: String
        let name: String
        var displayName: String?
        let enabled: Bool
        let sessionTarget: String
        let payload: Params
        var payloadSource: Params?
        let schedule: Params
        let configRevision: String?

        var title: String {
            self.displayName ?? self.name
        }

        var instructionsKey: String? {
            guard self.payloadSource == nil else { return nil }
            switch self.payload["kind"]?.stringValue {
            case "agentTurn": return "message"
            case "systemEvent": return "text"
            default: return nil
            }
        }

        func revisionParams() throws -> Params {
            guard let rev = self.configRevision, !rev.isEmpty else { throw AutomationFormError.noRevision }
            return ["id": .init(self.id), "expectedConfigRevision": .init(rev)]
        }
    }

    struct Runs: Decodable, Sendable {
        struct Entry: Decodable, Sendable {
            let ts: Int64
            var status: String?
            var summary: String?
            var error: String?
        }

        let entries: [Entry]
        let nextOffset: Int?
    }

    struct RemoveResult: Decodable, Sendable { let removed: Bool }
    struct RunResult: Decodable, Sendable { let enqueued: Bool?
        let ran: Bool?
        let reason: String?
    }
}

enum AutomationFormError: LocalizedError {
    case noRevision, changed, invalid, removed, pastDate
    var errorDescription: String? {
        switch self {
        case .noRevision: String(localized: "Refresh this automation before making changes.")
        case .changed: String(localized: "The list changed. Try again to reload it.")
        case .removed: String(localized: "This automation changed or was deleted. Refresh to check.")
        case .pastDate: String(localized: "Choose a future date and time.")
        case .invalid: String(localized: "Check the name, instructions, and schedule.")
        }
    }
}
