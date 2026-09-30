#if os(macOS)
import Foundation
import OpenClawProtocol

extension OpenClawChatGatewayRequests {
    static func sidebarPinOrder(_ entries: [String], hash: String) throws -> OpenClawChatGatewayRequest {
        let raw = try JSONEncoder().encode(["ui": ["prefs": ["sidebarEntries": entries]]])
        return .init(method: "config.patch", params: [
            "raw": .init(String(decoding: raw, as: UTF8.self)), "baseHash": .init(hash),
            "replacePaths": .init(["ui.prefs.sidebarEntries"]), "note": .init("control-ui prefs sync"),
        ], timeoutMs: 15000)
    }

    static func sidebarBatchPatch(
        _ rows: [OpenClawChatSessionEntry], patch: [String: AnyCodable]) -> OpenClawChatGatewayRequest
    {
        let targets = rows.map { row in
            var target = self.sessionMenuTarget(row)
            if let id = row.sessionId { target["expectedSessionId"] = .init(id) }
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
