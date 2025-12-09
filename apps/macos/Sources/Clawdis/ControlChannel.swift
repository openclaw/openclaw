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

struct ControlAgentEvent: Codable, Sendable {
    let runId: String
    let seq: Int
    let stream: String
    let ts: Double
    let data: [String: AnyCodable]
}

struct AnyCodable: Codable, @unchecked Sendable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let intVal = try? container.decode(Int.self) { self.value = intVal; return }
        if let doubleVal = try? container.decode(Double.self) { self.value = doubleVal; return }
        if let boolVal = try? container.decode(Bool.self) { self.value = boolVal; return }
        if let stringVal = try? container.decode(String.self) { self.value = stringVal; return }
        if container.decodeNil() { self.value = NSNull(); return }
        if let dict = try? container.decode([String: AnyCodable].self) { self.value = dict; return }
        if let array = try? container.decode([AnyCodable].self) { self.value = array; return }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type")
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self.value {
        case let intVal as Int: try container.encode(intVal)
        case let doubleVal as Double: try container.encode(doubleVal)
        case let boolVal as Bool: try container.encode(boolVal)
        case let stringVal as String: try container.encode(stringVal)
        case is NSNull: try container.encodeNil()
        case let dict as [String: AnyCodable]: try container.encode(dict)
        case let array as [AnyCodable]: try container.encode(array)
        default:
            let context = EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "Unsupported type")
            throw EncodingError.invalidValue(self.value, context)
        }
    }
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
        do {
            self.state = .connecting
            await gateway.configure(url: gatewayURL, token: gatewayToken)
            self.startEventStream()
            self.state = .connected
            PresenceReporter.shared.sendImmediate(reason: "connect")
        } catch {
            self.state = .degraded(error.localizedDescription)
        }
    }

    func configure(mode _: Any? = nil) async throws { await self.configure() }

    func health(timeout: TimeInterval? = nil) async throws -> Data {
        do {
            let start = Date()
            var params: [String: AnyHashable]? = nil
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
        return nil
    }

    func request(method: String, params: [String: AnyHashable]? = nil) async throws -> Data {
        do {
            let rawParams = params?.reduce(into: [String: Any]()) { $0[$1.key] = $1.value }
            let data = try await gateway.request(method: method, params: rawParams)
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
        for tok in eventTokens { NotificationCenter.default.removeObserver(tok) }
        eventTokens.removeAll()
        let ev = NotificationCenter.default.addObserver(
            forName: .gatewayEvent,
            object: nil,
            queue: .main
        ) { note in
            guard let obj = note.userInfo as? [String: Any],
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
                    AgentEventStore.shared.append(ControlAgentEvent(runId: runId, seq: seq, stream: stream, ts: ts, data: wrapped))
                }
            case "presence":
                // InstancesStore listens separately via notification
                break
            case "shutdown":
                self.state = .degraded("gateway shutdown")
            default:
                break
            }
        }
        let tick = NotificationCenter.default.addObserver(
            forName: .gatewaySnapshot,
            object: nil,
            queue: .main
        ) { _ in
            self.state = .connected
        }
        eventTokens = [ev, tick]
    }
}

extension Notification.Name {
    static let controlHeartbeat = Notification.Name("clawdis.control.heartbeat")
    static let controlAgentEvent = Notification.Name("clawdis.control.agent")
}
