#if os(macOS)
import Foundation
import OpenClawProtocol

extension OpenClawChatGatewayRequests {
    static func sidebarBatchPatch(
        _ rows: [OpenClawChatSessionEntry],
        patch: [String: AnyCodable],
        expectedArchived: Bool? = nil) -> OpenClawChatGatewayRequest
    {
        let targets = rows.map { row in
            var target = self.sessionMenuTarget(row)
            if let id = row.sessionId { target["expectedSessionId"] = .init(id) }
            if let expectedArchived { target["expectedArchived"] = .init(expectedArchived) }
            return target
        }
        // ui/src/lib/sessions/session-requests.ts:189: archive waits for workspace reconciliation.
        return .init(
            method: "sessions.patchMany",
            params: ["targets": .init(targets), "patch": .init(patch)],
            timeoutMs: patch["archived"]?.value as? Bool == true ? 600_000 : 15000)
    }

    static func sidebarBatchDelete(_ row: OpenClawChatSessionEntry) -> OpenClawChatGatewayRequest {
        var params = self.sessionMenuTarget(row)
        params["deleteTranscript"] = .init(true)
        if let id = row.sessionId { params["expectedSessionId"] = .init(id) }
        if row.isArchived { params["archivedOnly"] = .init(true) }
        return .init(method: "sessions.delete", params: params, timeoutMs: 600_000)
    }
}
#endif
