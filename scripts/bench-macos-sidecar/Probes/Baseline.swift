import Foundation
import OpenClawKit
import OpenClawProtocol

@main struct Bench {
    static func main() async throws {
        let url = URL(string: CommandLine.arguments[1])!
        let session = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["benchmark"],
            commands: ["benchmark.echo"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "RFC54 benchmark",
            includeDeviceIdentity: false,
            allowStoredDeviceAuth: false)
        let transport = URLSession(configuration: .ephemeral)
        let start = ContinuousClock.now
        try await session.connect(
            url: url,
            token: "benchmark-token",
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: transport),
            onConnected: {},
            onDisconnected: { reason in
                FileHandle.standardError.write(Data(("disconnected: " + reason + "\n").utf8))
            },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: req.paramsJSON)
            })
        let duration = start.duration(to: .now)
        let ms = Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
        print("{\"connectedMs\":\(ms),\"pid\":\(ProcessInfo.processInfo.processIdentifier)}")
        fflush(stdout)
        while readLine() != nil {}
        await session.disconnect()
        transport.invalidateAndCancel()
    }
}
