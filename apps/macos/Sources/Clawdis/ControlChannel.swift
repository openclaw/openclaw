import ClawdisProtocol
import Foundation
import OSLog
import SwiftUI

struct ControlHeartbeatEvent: Codable {
    let ts: Double
    let status: String
    let to: String?
    let preview: String?
    let durationMs: Double?
    let hasMedia: Bool?
    let reason: String?
}

struct ControlAgentEvent: Codable, Sendable, Identifiable {
    var id: String { "\(self.runId)-\(self.seq)" }
    let runId: String
    let seq: Int
    let stream: String
    let ts: Double
    let data: [String: AnyCodable]
    let summary: String?
}

enum ControlChannelError: Error, LocalizedError {
    case disconnected
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .disconnected: "Control channel disconnected"
        case let .badResponse(msg): msg
        }
    }
}

@MainActor
final class ControlChannel: ObservableObject {
    static let shared = ControlChannel()

    enum Mode {
        case local
        case remote(target: String, identity: String)
    }

    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case degraded(String)
    }

    @Published private(set) var state: ConnectionState = .disconnected
    @Published private(set) var lastPingMs: Double?

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "control")

    private var eventTask: Task<Void, Never>?

    private init() {
        self.startEventStream()
    }

    func configure() async {
        self.state = .connecting
        do {
            try await GatewayConnection.shared.refresh()
            self.state = .connected
            PresenceReporter.shared.sendImmediate(reason: "connect")
        } catch {
            let message = self.friendlyGatewayMessage(error)
            self.state = .degraded(message)
        }
    }

    func configure(mode: Mode = .local) async throws {
        switch mode {
        case .local:
            await self.configure()
        case let .remote(target, identity):
            // Create/ensure SSH tunnel, then talk to the forwarded local port.
            _ = (target, identity)
            do {
                _ = try await RemoteTunnelManager.shared.ensureControlTunnel()
                await self.configure()
            } catch {
                self.state = .degraded(error.localizedDescription)
                throw error
            }
        }
    }

    func health(timeout: TimeInterval? = nil) async throws -> Data {
        do {
            let start = Date()
            var params: [String: AnyHashable]?
            if let timeout {
                params = ["timeout": AnyHashable(Int(timeout * 1000))]
            }
            let timeoutMs = (timeout ?? 15) * 1000
            let payload = try await self.request(method: "health", params: params, timeoutMs: timeoutMs)
            let ms = Date().timeIntervalSince(start) * 1000
            self.lastPingMs = ms
            self.state = .connected
            return payload
        } catch {
            let message = self.friendlyGatewayMessage(error)
            self.state = .degraded(message)
            throw ControlChannelError.badResponse(message)
        }
    }

    func lastHeartbeat() async throws -> ControlHeartbeatEvent? {
        // Heartbeat removed in new protocol
        nil
    }

    func request(
        method: String,
        params: [String: AnyHashable]? = nil,
        timeoutMs: Double? = nil) async throws -> Data
    {
        do {
            let rawParams = params?.reduce(into: [String: AnyCodable]()) { $0[$1.key] = AnyCodable($1.value) }
            let data = try await GatewayConnection.shared.request(method: method, params: rawParams, timeoutMs: timeoutMs)
            self.state = .connected
            return data
        } catch {
            let message = self.friendlyGatewayMessage(error)
            self.state = .degraded(message)
            throw ControlChannelError.badResponse(message)
        }
    }

    private func friendlyGatewayMessage(_ error: Error) -> String {
        // Map URLSession/WS errors into user-facing, actionable text.
        if let ctrlErr = error as? ControlChannelError, let desc = ctrlErr.errorDescription {
            return desc
        }

        // If the gateway explicitly rejects the hello (e.g., auth/token mismatch), surface it.
        if let urlErr = error as? URLError,
           urlErr.code == .dataNotAllowed // used for WS close 1008 auth failures
        {
            let reason = urlErr.failureURLString ?? urlErr.localizedDescription
            return "Gateway rejected token; set CLAWDIS_GATEWAY_TOKEN in the mac app environment or clear it on the gateway. Reason: \(reason)"
        }

        // Common misfire: we connected to localhost:18789 but the port is occupied
        // by some other process (e.g. a local dev gateway or a stuck SSH forward).
        // The gateway handshake returns something we can't parse, which currently
        // surfaces as "hello failed (unexpected response)". Give the user a pointer
        // to free the port instead of a vague message.
        let nsError = error as NSError
        if nsError.domain == "Gateway",
           nsError.localizedDescription.contains("hello failed (unexpected response)")
        {
            let port = GatewayEnvironment.gatewayPort()
            return """
            Gateway handshake got non-gateway data on localhost:\(port).
            Another process is using that port or the SSH forward failed.
            Stop the local gateway/port-forward on \(port) and retry Remote mode.
            """
        }

        if let urlError = error as? URLError {
            let port = GatewayEnvironment.gatewayPort()
            switch urlError.code {
            case .cancelled:
                return "Gateway connection was closed; start the gateway (localhost:\(port)) and retry."
            case .cannotFindHost, .cannotConnectToHost:
                return "Cannot reach gateway at localhost:\(port); ensure the gateway is running."
            case .networkConnectionLost:
                return "Gateway connection dropped; gateway likely restarted—retry."
            case .timedOut:
                return "Gateway request timed out; check gateway on localhost:\(port)."
            case .notConnectedToInternet:
                return "No network connectivity; cannot reach gateway."
            default:
                break
            }
        }

        if nsError.domain == "Gateway", nsError.code == 5 {
            let port = GatewayEnvironment.gatewayPort()
            return "Gateway request timed out; check the gateway process on localhost:\(port)."
        }

        let detail = nsError.localizedDescription.isEmpty ? "unknown gateway error" : nsError.localizedDescription
        return "Gateway error: \(detail)"
    }

    func sendSystemEvent(_ text: String, params: [String: AnyHashable] = [:]) async throws {
        var merged = params
        merged["text"] = AnyHashable(text)
        _ = try await self.request(method: "system-event", params: merged)
    }

    private func startEventStream() {
        self.eventTask?.cancel()
        self.eventTask = Task { [weak self] in
            guard let self else { return }
            let stream = await GatewayConnection.shared.subscribe()
            for await push in stream {
                if Task.isCancelled { return }
                await MainActor.run { [weak self] in
                    self?.handle(push: push)
                }
            }
        }
    }

    private func handle(push: GatewayPush) {
        switch push {
        case let .event(evt) where evt.event == "agent":
            if let payload = evt.payload,
               let payloadData = try? JSONEncoder().encode(payload),
               let agent = try? JSONDecoder().decode(ControlAgentEvent.self, from: payloadData)
            {
                AgentEventStore.shared.append(agent)
                self.routeWorkActivity(from: agent)
            }
        case let .event(evt) where evt.event == "shutdown":
            self.state = .degraded("gateway shutdown")
        case .snapshot:
            self.state = .connected
        default:
            break
        }
    }

    private func routeWorkActivity(from event: ControlAgentEvent) {
        // We currently treat VoiceWake as the "main" session for UI purposes.
        // In the future, the gateway can include a sessionKey to distinguish runs.
        let sessionKey = (event.data["sessionKey"]?.value as? String) ?? "main"

        switch event.stream.lowercased() {
        case "job":
            if let state = event.data["state"]?.value as? String {
                WorkActivityStore.shared.handleJob(sessionKey: sessionKey, state: state)
            }
        case "tool":
            let phase = event.data["phase"]?.value as? String ?? ""
            let name = event.data["name"]?.value as? String
            let meta = event.data["meta"]?.value as? String
            let args = event.data["args"]?.value as? [String: AnyCodable]
            WorkActivityStore.shared.handleTool(
                sessionKey: sessionKey,
                phase: phase,
                name: name,
                meta: meta,
                args: args)
        default:
            break
        }
    }
}

extension Notification.Name {
    static let controlHeartbeat = Notification.Name("clawdis.control.heartbeat")
    static let controlAgentEvent = Notification.Name("clawdis.control.agent")
}
