import CryptoKit
import Foundation

/// Supervisor half of `openclaw-node-host`'s authenticated sidecar protocol v1.
/// The owning process session serializes access; reference identity keeps retirement and sequences shared.
final class AuthenticatedSidecarChannel {
    enum Failure: Error, Equatable {
        case invalidConfiguration, retired, frameTooLarge, frameLimitLocked
        case authentication, invalidHeader, wrongDirection, wrongGeneration, wrongSequence, wrongSession, invalidPayload
    }

    private static var headerBytes: Int {
        31
    }

    private static var tagBytes: Int {
        32
    }

    private let sessionID: Data
    private let generation: UInt64
    private var key: SymmetricKey?
    private var sendSequence: UInt64 = 0
    private var receiveSequence: UInt64 = 0
    private var frameLimitLocked = false
    private(set) var maxFrameBytes: Int

    var isRetired: Bool {
        self.key == nil
    }

    var maxPayloadBytes: Int {
        self.maxFrameBytes - Self.headerBytes - self.sessionID.count - Self.tagBytes
    }

    init(key: Data, sessionID: String, generation: UInt64, maxFrameBytes: Int = 16_777_216) throws {
        let session = Data(sessionID.utf8)
        guard key.count == 32, !session.isEmpty, session.count <= Int(UInt16.max), generation != 0,
              maxFrameBytes <= Int(UInt32.max),
              maxFrameBytes >= Self.headerBytes + session.count + Self.tagBytes + 1
        else { throw Failure.invalidConfiguration }
        self.sessionID = session
        self.generation = generation
        self.key = SymmetricKey(data: key)
        self.maxFrameBytes = maxFrameBytes
    }

    func retire() {
        self.key = nil
    }

    func lowerFrameLimit(_ limit: Int) throws {
        guard !self.isRetired else { throw Failure.retired }
        guard !self.frameLimitLocked else { throw Failure.frameLimitLocked }
        guard limit <= self.maxFrameBytes,
              limit >= Self.headerBytes + self.sessionID.count + Self.tagBytes + 1
        else { throw Failure.invalidConfiguration }
        self.maxFrameBytes = limit
    }

    func lockFrameLimit() {
        self.frameLimitLocked = true
    }

    /// The prefix is transport framing; the HMAC covers the header, session ID, and exact JSON bytes.
    func seal(_ payload: Data) throws -> Data {
        guard let key = self.key else { throw Failure.retired }
        guard payload.count <= self.maxPayloadBytes else { throw Failure.frameTooLarge }
        guard self.sendSequence < UInt64.max else { throw Failure.wrongSequence }
        let sequence = self.sendSequence + 1
        var frame = Data("OCSC".utf8)
        Self.append(UInt16(1), to: &frame)
        Self.append(UInt16(0), to: &frame)
        frame.append(1) // Supervisor -> runtime; accepting this direction would permit reflection.
        Self.append(self.generation, to: &frame)
        Self.append(sequence, to: &frame)
        Self.append(UInt16(self.sessionID.count), to: &frame)
        Self.append(UInt32(payload.count), to: &frame)
        frame.append(self.sessionID)
        frame.append(payload)
        frame.append(contentsOf: HMAC<SHA256>.authenticationCode(for: frame, using: key))
        var prefixed = Data()
        Self.append(UInt32(frame.count), to: &prefixed)
        prefixed.append(frame)
        self.sendSequence = sequence
        return prefixed
    }

    /// The caller bounds the length prefix before allocating and retires on I/O or typed-message errors.
    func open(_ frame: Data) throws -> Data {
        guard let key = self.key else { throw Failure.retired }
        do {
            guard frame.count <= self.maxFrameBytes else { throw Failure.frameTooLarge }
            guard frame.count >= Self.headerBytes + Self.tagBytes else { throw Failure.invalidHeader }
            let authenticated = frame.dropLast(Self.tagBytes)
            guard HMAC<SHA256>.isValidAuthenticationCode(
                frame.suffix(Self.tagBytes), authenticating: authenticated, using: key)
            else { throw Failure.authentication }
            // Authenticate before parsing any peer-controlled header fields.
            guard authenticated.prefix(4).elementsEqual("OCSC".utf8),
                  Self.integer(authenticated, at: 4, bytes: 2) == 1,
                  Self.integer(authenticated, at: 6, bytes: 2) == 0
            else { throw Failure.invalidHeader }
            guard Self.integer(authenticated, at: 8, bytes: 1) == 2 else { throw Failure.wrongDirection }
            guard Self.integer(authenticated, at: 9, bytes: 8) == self.generation else { throw Failure.wrongGeneration }
            guard self.receiveSequence < UInt64.max,
                  Self.integer(authenticated, at: 17, bytes: 8) == self.receiveSequence + 1
            else { throw Failure.wrongSequence }
            let sessionBytes = Int(Self.integer(authenticated, at: 25, bytes: 2))
            let payloadBytes = Int(Self.integer(authenticated, at: 27, bytes: 4))
            guard sessionBytes == self.sessionID.count,
                  Self.headerBytes + sessionBytes + payloadBytes == authenticated.count
            else { throw Failure.invalidHeader }
            guard authenticated.dropFirst(Self.headerBytes).prefix(sessionBytes) == self.sessionID
            else { throw Failure.wrongSession }
            let payload = Data(authenticated.suffix(payloadBytes))
            guard (try? JSONSerialization.jsonObject(with: payload, options: [.fragmentsAllowed])) != nil
            else { throw Failure.invalidPayload }
            self.receiveSequence += 1
            return payload
        } catch {
            self.retire()
            throw error
        }
    }

    private static func append(_ value: some FixedWidthInteger, to data: inout Data) {
        var bigEndian = value.bigEndian
        withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
    }

    private static func integer(_ bytes: Data, at offset: Int, bytes count: Int) -> UInt64 {
        bytes.dropFirst(offset).prefix(count).reduce(0) { ($0 << 8) | UInt64($1) }
    }
}
