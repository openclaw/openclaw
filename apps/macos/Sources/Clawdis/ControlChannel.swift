import Foundation
import OSLog
import SwiftUI
import ClawdisProtocol

struct ControlHeartbeatEvent: Codable {
    let ts: Double
    let status: String
    let to: String?
    let preview: String?
    let durationMs: Double?
    let hasMedia: Bool?
    let reason: String?
}

struct ControlAgentEvent: Codable, Sendable {
    let runId: String
    let seq: Int
    let stream: String
    let ts: Double
    let data: [String: AnyCodable]
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
        let port = UserDefaults.standard.integer(forKey: "gatewayPort")
        let effectivePort = port > 0 ? port : 18789
        return URL(string: "ws://127.0.0.1:\(effectivePort)")!
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
            let payload = try await self.request(method: "health", params: params)
            let ms = Date().timeIntervalSince(start) * 1000
            self.lastPingMs = ms
            self.state = .connected
            return payload
        } catch {
            self.state = .degraded(error.localizedDescription)
            throw error
        }
    }

    func lastHeartbeat() async throws -> ControlHeartbeatEvent? {
        // Heartbeat removed in new protocol
        nil
    }

    func request(method: String, params: [String: AnyHashable]? = nil) async throws -> Data {
        do {
            let rawParams = params?.reduce(into: [String: AnyCodable]()) { $0[$1.key] = AnyCodable($1.value) }
            let data = try await self.gateway.request(method: method, params: rawParams)
            self.state = .connected
            return data
        } catch {
            self.state = .degraded(error.localizedDescription)
            throw error
        }
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
                  let obj = note.userInfo as? [String: Any],
                  let event = obj["event"] as? String else { return }
            switch event {
            case "agent":
                if let payload = obj["payload"] as? [String: Any],
                   let runId = payload["runId"] as? String,
                   let seq = payload["seq"] as? Int,
                   let stream = payload["stream"] as? String,
                   let ts = payload["ts"] as? Double,
                   let dataDict = payload["data"] as? [String: Any]
                {
                    let wrapped = dataDict.mapValues { AnyCodable($0) }
                    Task { @MainActor in
                        AgentEventStore.shared.append(ControlAgentEvent(
                            runId: runId,
                            seq: seq,
                            stream: stream,
                            ts: ts,
                            data: wrapped))
                    }
                }
            case "presence":
                // InstancesStore listens separately via notification
                break
            case "shutdown":
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
