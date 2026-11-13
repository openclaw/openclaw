import Foundation

/// Narrow boundary implemented by the native binding. Operations must honor cancellation;
/// shutdown releases pending reads, writes, accepts and dials before returning.
public protocol OpenClawIDNodeEndpoint: Sendable {
    func connect(serverKey: String, relayURL: URL, alpn: Data) async throws -> any OpenClawIDNodeConnection
    func relayStatus() async -> [OpenClawIDNodeRelayStatus]
    func shutdown() async
}

public struct OpenClawIDNodeRelayStatus: Sendable, Equatable {
    // periphery:ignore - Used only by the opt-in native iroh build (OPENCLAW_IROH_NATIVE), which the Periphery scans do not compile.
    public let connected: Bool
    public let admissionDenied: Bool

    // periphery:ignore - Used only by the opt-in native iroh build (OPENCLAW_IROH_NATIVE), which the Periphery scans do not compile.
    public init(connected: Bool, admissionDenied: Bool) {
        self.connected = connected
        self.admissionDenied = admissionDenied
    }
}

public struct OpenClawIDNodeClose: Sendable, Equatable {
    /// QUIC application codes are 62-bit values. Never narrow unknown codes to UInt32.
    public let code: Int64?
    public let kind: Kind

    // periphery:ignore - Used only by the opt-in native iroh build (OPENCLAW_IROH_NATIVE), which the Periphery scans do not compile.
    public enum Kind: Sendable, Equatable { case application, local, timedOut, reset, transport }

    public init(code: Int64?, kind: Kind) {
        self.code = code
        self.kind = kind
    }

    public var requiresReenrollment: Bool {
        self.kind == .application && (self.code == 1 || self.code == 2)
    }
}

public protocol OpenClawIDNodeConnection: Sendable {
    func openBi() async throws -> any OpenClawIDNodeStream
    func closed() async throws -> OpenClawIDNodeClose
    func close(code: Int64) async
}

public protocol OpenClawIDNodeStream: Sendable {
    /// At most maxBytes; nil means FIN. Empty chunks are not permitted.
    func read(maxBytes: Int) async throws -> Data?
    /// Resolves only after all bytes are accepted with transport backpressure.
    func write(_ bytes: Data) async throws
    func finish() async throws
    func reset(code: Int64) async
    func stop(code: Int64) async
}

public enum OpenClawIDNodeTransportError: Error, Sendable, Equatable {
    case malformedFrame
    case oversizedFrame
    case truncatedFrame
    case invalidHead
    case unsupportedOpcode
    case upgradeRejected(Int)
    case webSocketClosed(UInt16?, String)
    case removed
    case closed
    case deadline
    case wrongRoute
    case nodeRoleRequired
}

/// The platform adapter binds with Minimal, a single selected relay and this keep-alive.
public enum OpenClawIDNodeTunnelProtocol {
    public static let alpn = Data("openclaw/tunnel/1".utf8)
    // periphery:ignore - Used only by the opt-in native iroh build (OPENCLAW_IROH_NATIVE), which the Periphery scans do not compile.
    public static let keepAliveMilliseconds: UInt32 = 1000
    public static let maximumFrameBytes = 32 * 1024 * 1024
    public static let maximumHeadBytes = 64 * 1024
    public static let maximumHTTPDataBytes = 1024 * 1024
}
