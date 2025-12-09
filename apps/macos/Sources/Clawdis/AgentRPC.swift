import Foundation
import OSLog

struct ControlRequestParams: @unchecked Sendable {
    let raw: [String: AnyHashable]
}

actor AgentRPC {
    static let shared = AgentRPC()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "agent.rpc")
    private let gateway = GatewayChannel()
    private var configured = false

    private var gatewayURL: URL {
        let port = UserDefaults.standard.integer(forKey: "gatewayPort")
        let effectivePort = port > 0 ? port : 18789
        return URL(string: "ws://127.0.0.1:\(effectivePort)")!
    }

    private var gatewayToken: String? {
        ProcessInfo.processInfo.environment["CLAWDIS_GATEWAY_TOKEN"]
    }

    func start() async throws {
        if configured { return }
        await gateway.configure(url: gatewayURL, token: gatewayToken)
        configured = true
    }

    func shutdown() async {
        // no-op for WS; socket managed by GatewayChannel
    }

    func setHeartbeatsEnabled(_ enabled: Bool) async -> Bool {
        do {
            _ = try await controlRequest(method: "set-heartbeats", params: ControlRequestParams(raw: ["enabled": AnyHashable(enabled)]))
            return true
        } catch {
            logger.error("setHeartbeatsEnabled failed \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func status() async -> (ok: Bool, error: String?) {
        do {
            let data = try await controlRequest(method: "status")
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               (obj["ok"] as? Bool) ?? true {
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
        session: String,
        deliver: Bool,
        to: String?) async -> (ok: Bool, text: String?, error: String?)
    {
        do {
            let params: [String: AnyHashable] = [
                "message": AnyHashable(text),
                "sessionId": AnyHashable(session),
                "thinking": AnyHashable(thinking ?? "default"),
                "deliver": AnyHashable(deliver),
                "to": AnyHashable(to ?? ""),
                "idempotencyKey": AnyHashable(UUID().uuidString),
            ]
            _ = try await controlRequest(method: "agent", params: ControlRequestParams(raw: params))
            return (true, nil, nil)
        } catch {
            return (false, nil, error.localizedDescription)
        }
    }

    func controlRequest(method: String, params: ControlRequestParams? = nil) async throws -> Data {
        try await start()
        let rawParams = params?.raw.reduce(into: [String: Any]()) { $0[$1.key] = $1.value }
        return try await gateway.request(method: method, params: rawParams)
    }
}
