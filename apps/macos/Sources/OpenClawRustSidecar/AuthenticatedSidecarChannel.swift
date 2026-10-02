import CryptoKit
import Foundation

/// Envelopes borrow the original body; only their small prefix and suffix are copied.
struct SidecarPayload: Sendable {
    enum Format: Sendable { case json, transport }

    enum Body: Sendable {
        case data(Data)
        case utf8(String)

        var count: Int {
            switch self {
            case let .data(data): data.count
            case let .utf8(text): text.utf8.count
            }
        }

        func withUnsafeBytes<Result>(_ body: (UnsafeRawBufferPointer) throws -> Result) rethrows -> Result {
            switch self {
            case let .data(data): try data.withUnsafeBytes(body)
            case var .utf8(text): try text.withUTF8 { try body(UnsafeRawBufferPointer($0)) }
            }
        }
    }

    let format: Format
    let body: Body
    let prefix: Data
    let suffix: Data

    init(_ data: Data, prefix: Data = Data(), suffix: Data = Data()) {
        self.init(body: .data(data), prefix: prefix, suffix: suffix)
    }

    init(body: Body, prefix: Data = Data(), suffix: Data = Data(), format: Format = .json) {
        self.format = format
        if case var .utf8(text) = body {
            text.makeContiguousUTF8()
            self.body = .utf8(text)
        } else {
            self.body = body
        }
        self.prefix = prefix
        self.suffix = suffix
    }

    var count: Int {
        self.prefix.count + self.body.count + self.suffix.count
    }

    var segments: [Body] {
        [.data(self.prefix), self.body, .data(self.suffix)]
    }
}

/// Supervisor half of `openclaw-node-host`'s authenticated sidecar protocol v1.
/// The owning process session serializes access; reference identity keeps retirement and sequences shared.
final class AuthenticatedSidecarChannel {
    /// Preserve the negotiated JSON/native-result frame ceiling; opaque transport
    /// has its own 25 MiB body bound. Keep the helper offer aligned.
    static let defaultMaxFrameBytes = ((25 * 1024 * 1024 + 2) / 3) * 4 + 4096

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
    private var opaqueTransport = false
    private(set) var maxFrameBytes: Int

    var isRetired: Bool {
        self.key == nil
    }

    var maxPayloadBytes: Int {
        self.maxFrameBytes - Self.headerBytes - self.sessionID.count - Self.tagBytes
    }

    init(
        key: Data,
        sessionID: String,
        generation: UInt64,
        maxFrameBytes: Int = AuthenticatedSidecarChannel.defaultMaxFrameBytes) throws
    {
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

    func lockFrameLimit(opaqueTransport: Bool = false) {
        guard !self.frameLimitLocked else { return }
        self.frameLimitLocked = true
        self.opaqueTransport = opaqueTransport
    }

    /// The prefix is transport framing; the HMAC covers the header, session ID, and exact payload bytes.
    func seal(_ payload: SidecarPayload) throws -> SidecarPayload {
        guard let key = self.key else { throw Failure.retired }
        guard payload.count <= self.maxPayloadBytes else { throw Failure.frameTooLarge }
        guard payload.format != .transport || self.opaqueTransport else { throw Failure.invalidHeader }
        guard self.sendSequence < UInt64.max else { throw Failure.wrongSequence }
        let sequence = self.sendSequence + 1
        let frameBytes = Self.headerBytes + self.sessionID.count + payload.count + Self.tagBytes
        var frame = Data(capacity: Self.headerBytes + self.sessionID.count + payload.prefix.count + 4)
        Self.append(UInt32(frameBytes), to: &frame)
        frame.append(contentsOf: (payload.format == .transport ? "OCMT" : "OCSC").utf8)
        Self.append(UInt16(1), to: &frame)
        Self.append(UInt16(0), to: &frame)
        frame.append(1) // Supervisor -> runtime; accepting this direction would permit reflection.
        Self.append(self.generation, to: &frame)
        Self.append(sequence, to: &frame)
        Self.append(UInt16(self.sessionID.count), to: &frame)
        Self.append(UInt32(payload.count), to: &frame)
        frame.append(self.sessionID)
        var authentication = HMAC<SHA256>(key: key)
        authentication.update(data: frame.dropFirst(4))
        for segment in payload.segments {
            segment.withUnsafeBytes { authentication.update(data: $0) }
        }
        frame.append(payload.prefix)
        var suffix = payload.suffix
        suffix.append(contentsOf: authentication.finalize())
        self.sendSequence = sequence
        return SidecarPayload(body: payload.body, prefix: frame, suffix: suffix)
    }

    /// The caller bounds the length prefix before allocating and retires on I/O or typed-message errors.
    func open<Payload>(
        _ frame: Data,
        decode: (Data) throws -> Payload,
        transport: ((Data) throws -> Payload)? = nil) throws -> Payload
    {
        guard let key = self.key else { throw Failure.retired }
        do {
            guard frame.count <= self.maxFrameBytes else { throw Failure.frameTooLarge }
            guard frame.count >= Self.headerBytes + Self.tagBytes else { throw Failure.invalidHeader }
            let authenticated = frame.dropLast(Self.tagBytes)
            guard HMAC<SHA256>.isValidAuthenticationCode(
                frame.suffix(Self.tagBytes), authenticating: authenticated, using: key)
            else { throw Failure.authentication }
            // Authenticate before parsing any peer-controlled header fields.
            let isTransport = authenticated.prefix(4).elementsEqual("OCMT".utf8)
            let knownFormat = isTransport ? self.opaqueTransport && transport != nil :
                authenticated.prefix(4).elementsEqual("OCSC".utf8)
            guard knownFormat,
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
            // Decode only after authentication; typed-payload failures retire the same session.
            let payload: Payload
            do {
                if isTransport, let transport {
                    payload = try transport(authenticated.suffix(payloadBytes))
                } else {
                    payload = try decode(authenticated.suffix(payloadBytes))
                }
            } catch { throw Failure.invalidPayload }
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
