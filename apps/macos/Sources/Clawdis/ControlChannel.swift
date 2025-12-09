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
    private let gateway = GatewayChannel()
    private var gatewayURL: URL {
        let port = GatewayEnvironment.gatewayPort()
        return URL(string: "ws://127.0.0.1:\(port)")!
    }

    private var gatewayToken: String? {
        ProcessInfo.processInfo.environment["CLAWDIS_GATEWAY_TOKEN"]
    }

    private var eventTokens: [NSObjectProtocol] = []

    func configure() async {
        self.state = .connecting
        await self.gateway.configure(url: self.gatewayURL, token: self.gatewayToken)
        self.startEventStream()
        self.state = .connected
        PresenceReporter.shared.sendImmediate(reason: "connect")
    }

    func configure(mode: Mode = .local) async throws {
        switch mode {
        case .local:
            await self.configure()
        case let .remote(target, identity):
            // Remote mode assumed to have an existing tunnel; placeholders retained for future use.
            _ = (target, identity)
            await self.configure()
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
            let data = try await self.gateway.request(method: method, params: rawParams, timeoutMs: timeoutMs)
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

        let nsError = error as NSError
        if nsError.domain == "Gateway", nsError.code == 5 {
            return "Gateway request timed out; check the gateway process on localhost:\(GatewayEnvironment.gatewayPort())."
        }

        let detail = nsError.localizedDescription.isEmpty ? "unknown gateway error" : nsError.localizedDescription
        return "Gateway error: \(detail)"
    }

    func sendSystemEvent(_ text: String) async throws {
        _ = try await self.request(method: "system-event", params: ["text": AnyHashable(text)])
    }

    private func startEventStream() {
        for tok in self.eventTokens {
            NotificationCenter.default.removeObserver(tok)
        }
        self.eventTokens.removeAll()
        let ev = NotificationCenter.default.addObserver(
            forName: .gatewayEvent,
            object: nil,
            queue: .main)
        { [weak self] note in
            guard let self,
                  let frame = note.object as? GatewayFrame else { return }
            switch frame {
            case let .event(evt) where evt.event == "agent":
                if let data = evt.payload?.value,
                   JSONSerialization.isValidJSONObject(data),
                   let blob = try? JSONSerialization.data(withJSONObject: data),
                   let agent = try? JSONDecoder().decode(AgentEvent.self, from: blob)
                {
                    Task { @MainActor in
                        AgentEventStore.shared.append(ControlAgentEvent(
                            runId: agent.runid,
                            seq: agent.seq,
                            stream: agent.stream,
                            ts: Double(agent.ts),
                            data: agent.data.mapValues { Clawdis.AnyCodable($0.value) },
                            summary: nil))
                    }
                }
            case let .event(evt) where evt.event == "shutdown":
                Task { @MainActor in self.state = .degraded("gateway shutdown") }
            default:
                break
            }
        }
        let tick = NotificationCenter.default.addObserver(
            forName: .gatewaySnapshot,
            object: nil,
            queue: .main)
        { [weak self] _ in
            Task { @MainActor [weak self] in self?.state = .connected }
        }
        self.eventTokens = [ev, tick]
    }
}

extension Notification.Name {
    static let controlHeartbeat = Notification.Name("clawdis.control.heartbeat")
    static let controlAgentEvent = Notification.Name("clawdis.control.agent")
}
