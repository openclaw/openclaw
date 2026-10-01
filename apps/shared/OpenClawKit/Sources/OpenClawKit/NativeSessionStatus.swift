import Foundation
import OpenClawProtocol

/// A codec for an already selected connection, not an authenticated reader.
/// The host must verify the query's owner on that connection before dispatch.
/// All timestamps are Unix epoch milliseconds.
public enum OpenClawNativeSessionStatus {
    public enum Query: Sendable {
        case session(OpenClawNativeSessionRef, sessionID: String)
        case run(OpenClawNativeRunRef, sessionID: String)

        fileprivate var selection: (
            session: OpenClawNativeSessionRef,
            generation: String,
            run: OpenClawNativeRunRef?)
        {
            switch self {
            case let .session(session, sessionID):
                (session, sessionID, nil)
            case let .run(run, sessionID):
                (run.session, sessionID, run)
            }
        }
    }

    public enum AggregateStatus: String, Codable, Sendable {
        case queued, running, done, failed, killed, timeout
    }

    public enum TerminalStatus: String, Codable, Sendable {
        case done, failed, killed, timeout
    }

    public struct TerminalRun: Sendable {
        public let ref: OpenClawNativeRunRef
        public let status: TerminalStatus
        public let endedAt: Double?
    }

    public struct SessionFacts: Sendable {
        public let ref: OpenClawNativeSessionRef
        public let generation: String
        public let aggregateStatus: AggregateStatus?
        public let hasActiveRun: Bool
        public let updatedAt: Double?
        public let matchedRun: TerminalRun?
    }

    public struct Observation: Sendable {
        /// Query context only; neither the payload nor this codec authenticates it.
        public let owner: OpenClawNativeOwnerRef
        /// Observation and update timestamps do not renew cached run freshness.
        public let observedAt: Double
        public let session: SessionFacts?
    }

    public static func parameters(for query: Query) throws -> SessionsStatusParams {
        let selected = query.selection
        guard self.boundedNonblank(selected.session.sessionKey, maximum: 512),
              self.validAgentID(selected.session.agentID),
              self.boundedNonblank(selected.generation, maximum: 128),
              selected.run.map({ self.boundedNonblank($0.runID, maximum: 256) }) ?? true
        else {
            throw GatewayDecodingError(method: "sessions.status", message: "Invalid session status query.")
        }
        return SessionsStatusParams(
            key: selected.session.sessionKey,
            agentid: selected.session.agentID,
            sessionid: selected.generation,
            expectedrunid: selected.run?.runID)
    }

    public static func decode(_ data: Data, for query: Query) throws -> Observation {
        guard data.count <= 16 * 1024 else {
            throw GatewayDecodingError(
                method: "sessions.status",
                message: "Session status payload exceeds 16384 bytes.")
        }
        _ = try self.parameters(for: query)
        let selected = query.selection
        do {
            let result = try JSONDecoder().decode(SessionsStatusResult.self, from: data)
            try self.validateTimestamp(result.observedat)
            // Required nullable fields use the generated wrapper's actual NSNull shape.
            guard !(result.session.value is NSNull) else {
                return Observation(owner: selected.session.owner, observedAt: result.observedat, session: nil)
            }
            let session = try GatewayPayloadDecoding.decode(result.session, as: SessionStatus.self)
            try self.rejectNullOptionals(result.session, keys: ["status", "updatedAt"])
            guard session.key.utf8.elementsEqual(selected.session.sessionKey.utf8),
                  session.agentid.utf8.elementsEqual(selected.session.agentID.utf8),
                  session.sessionid.utf8.elementsEqual(selected.generation.utf8)
            else {
                throw GatewayDecodingError(
                    method: "sessions.status",
                    message: "Session status response does not match the selected session.")
            }
            let status = try session.status.map {
                try GatewayPayloadDecoding.decode($0, as: AggregateStatus.self)
            }
            if let updatedAt = session.updatedat {
                try self.validateTimestamp(updatedAt)
            }
            var matchedRun: TerminalRun?
            if !(session.matchedrun.value is NSNull) {
                guard let selectedRun = selected.run else {
                    throw GatewayDecodingError(
                        method: "sessions.status",
                        message: "Session status response includes an unselected run.")
                }
                let terminal = try GatewayPayloadDecoding.decode(
                    session.matchedrun,
                    as: SessionStatusMatchedRun.self)
                try self.rejectNullOptionals(session.matchedrun, keys: ["endedAt"])
                guard terminal.runid.utf8.elementsEqual(selectedRun.runID.utf8) else {
                    throw GatewayDecodingError(
                        method: "sessions.status",
                        message: "Session status response does not match the selected run.")
                }
                let terminalStatus = try GatewayPayloadDecoding.decode(terminal.status, as: TerminalStatus.self)
                if let endedAt = terminal.endedat {
                    try self.validateTimestamp(endedAt)
                }
                matchedRun = TerminalRun(ref: selectedRun, status: terminalStatus, endedAt: terminal.endedat)
            }
            return Observation(
                owner: selected.session.owner,
                observedAt: result.observedat,
                session: SessionFacts(
                    ref: selected.session,
                    generation: selected.generation,
                    aggregateStatus: status,
                    hasActiveRun: session.hasactiverun,
                    updatedAt: session.updatedat,
                    matchedRun: matchedRun))
        } catch let error as GatewayDecodingError {
            throw error
        } catch {
            // Decoder diagnostics may contain identifiers or payload fragments.
            throw GatewayDecodingError(method: "sessions.status", message: "Invalid session status payload.")
        }
    }

    private static func validateTimestamp(_ value: Double) throws {
        guard value.isFinite, value >= 0, value <= 9_007_199_254_740_991 else {
            throw GatewayDecodingError(method: "sessions.status", message: "Invalid session status timestamp.")
        }
    }

    private static func rejectNullOptionals(_ payload: AnyCodable, keys: [String]) throws {
        let fields = try GatewayPayloadDecoding.decode(payload, as: [String: AnyCodable].self)
        // Synthesized optional decoding conflates null with absence; the schema does not.
        guard !keys.contains(where: { fields[$0]?.value is NSNull }) else {
            throw GatewayDecodingError(method: "sessions.status", message: "Invalid session status payload.")
        }
    }

    private static func boundedNonblank(_ value: String, maximum: Int) -> Bool {
        let scalars = value.unicodeScalars
        guard !scalars.isEmpty, scalars.count <= maximum else { return false }
        return scalars.contains {
            // Match the protocol's ECMAScript whitespace set without changing the identifier.
            switch $0.value {
            case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A,
                 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
                false
            default:
                true
            }
        }
    }

    private static func validAgentID(_ value: String) -> Bool {
        func alphanumeric(_ byte: UInt8) -> Bool {
            (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
        }
        let bytes = value.utf8
        guard let first = bytes.first, alphanumeric(first), bytes.count <= 64 else { return false }
        return bytes.allSatisfy { alphanumeric($0) || $0 == 45 || $0 == 95 }
    }
}
