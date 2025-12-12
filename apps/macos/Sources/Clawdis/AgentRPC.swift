import Foundation
import OSLog

struct ControlRequestParams: @unchecked Sendable {
    /// Heterogeneous JSON-ish params (Bool/String/Int/Double/[...]/[String:...]).
    /// `@unchecked Sendable` is intentional: values are treated as immutable payloads.
    let raw: [String: Any]
}

actor AgentRPC {
    static let shared = AgentRPC()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "agent.rpc")

    func shutdown() async {
        // no-op; socket managed by GatewayConnection
    }

    func setHeartbeatsEnabled(_ enabled: Bool) async -> Bool {
        do {
            _ = try await self.controlRequest(
                method: "set-heartbeats",
                params: ControlRequestParams(raw: ["enabled": enabled]))
            return true
        } catch {
            self.logger.error("setHeartbeatsEnabled failed \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func status() async -> (ok: Bool, error: String?) {
        do {
            let data = try await controlRequest(method: "status")
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               (obj["ok"] as? Bool) ?? true
            {
                return (true, nil)
            }
            return (false, "status error")
        } catch {
            return (false, error.localizedDescription)
        }
    }

    func send(
        text: String,
        thinking: String?,
        sessionKey: String,
        deliver: Bool,
        to: String?,
        channel: String? = nil) async -> (ok: Bool, text: String?, error: String?)
    {
        do {
            let params: [String: Any] = [
                "message": text,
                "sessionKey": sessionKey,
                "thinking": thinking ?? "default",
                "deliver": deliver,
                "to": to ?? "",
                "channel": channel ?? "",
                "idempotencyKey": UUID().uuidString,
            ]
            _ = try await self.controlRequest(method: "agent", params: ControlRequestParams(raw: params))
            return (true, nil, nil)
        } catch {
            return (false, nil, error.localizedDescription)
        }
    }

    func controlRequest(method: String, params: ControlRequestParams? = nil) async throws -> Data {
        let rawParams = params?.raw.reduce(into: [String: AnyCodable]()) { $0[$1.key] = AnyCodable($1.value) }
        return try await GatewayConnection.shared.request(method: method, params: rawParams)
    }
}
