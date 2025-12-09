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

    enum Mode: Equatable {
        case local
        case remote(target: String, identity: String)
    }

    @Published private(set) var state: ConnectionState = .disconnected
    @Published private(set) var lastPingMs: Double?

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "control")

    func configure() async {
        do {
            self.state = .connecting
            try await AgentRPC.shared.start()
            self.state = .connected
            PresenceReporter.shared.sendImmediate(reason: "connect")
        } catch {
            self.state = .degraded(error.localizedDescription)
        }
    }

    func configure(mode: Mode) async throws {
        // Mode is retained for API compatibility; transport is always stdio now.
        await self.configure()
    }

    func health(timeout: TimeInterval? = nil) async throws -> Data {
        let params = timeout.map { ControlRequestParams(raw: ["timeoutMs": AnyHashable(Int($0 * 1000))]) }
        do {
            let start = Date()
            let payload = try await AgentRPC.shared.controlRequest(method: "health", params: params)
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
        let data = try await AgentRPC.shared.controlRequest(method: "last-heartbeat")
        if data.isEmpty { return nil }
        return try? JSONDecoder().decode(ControlHeartbeatEvent.self, from: data)
    }

    func request(method: String, params: ControlRequestParams? = nil) async throws -> Data {
        do {
            let data = try await AgentRPC.shared.controlRequest(method: method, params: params)
            self.state = .connected
            return data
        } catch {
            self.state = .degraded(error.localizedDescription)
            throw error
        }
    }

    func sendSystemEvent(_ text: String) async throws {
        _ = try await self.request(
            method: "system-event",
            params: ControlRequestParams(raw: ["text": AnyHashable(text)]))
    }
}

extension Notification.Name {
    static let controlHeartbeat = Notification.Name("clawdis.control.heartbeat")
    static let controlAgentEvent = Notification.Name("clawdis.control.agent")
}
