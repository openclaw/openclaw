import Foundation
import OpenClawKit
import OpenClawRustSidecar

@main struct TLSProbe {
    static func main() async throws {
        let url = URL(string: CommandLine.arguments[1])!
        let pin = CommandLine.arguments[3]
        let transport = RustGatewayWebSocketSession(
            executableURL: URL(fileURLWithPath: CommandLine.arguments[2]),
            fingerprint: pin)
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: CommandLine.arguments.last == "empty" ? [] : ["benchmark.echo"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "RFC54 TLS probe",
            includeDeviceIdentity: false,
            allowStoredDeviceAuth: false)
        let channel = GatewayChannelActor(
            url: url,
            token: "benchmark-token",
            session: WebSocketSessionBox(session: transport),
            pushHandler: { _, _ in },
            connectOptions: options,
            extraHeadersProvider: { ["X-RFC54-Probe": "test-marker"] })
        var result: [String: Any]
        do { try await channel.connect()
            result = ["connected": true, "effectiveFingerprint": transport.effectiveTLSFingerprintSHA256 ?? "none"]
        } catch let error as GatewayTLSValidationError { result = [
            "connected": false,
            "typedTLSFailure": true,
            "kind": error.failure.kind.rawValue,
            "observedFingerprint": error.failure.observedFingerprint ?? "none",
            "systemTrustOk": error.failure.systemTrustOk,
        ] } catch { result = ["connected": false, "typedTLSFailure": false, "error": error.localizedDescription] }
        await channel.shutdown()
        try print(String(
            decoding: JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
            as: UTF8.self))
        fflush(stdout)
    }
}
