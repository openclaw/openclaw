import Foundation
import OpenClawKit
import OpenClawProtocol
import OpenClawRustSidecar

actor InputInbox {
    var waiting: [String: CheckedContinuation<String, Never>] = [:]
    var buffered: [String: String] = [:]
    func take(_ id: String) async -> String {
        if let value = buffered.removeValue(forKey: id) { return value }
        return await withCheckedContinuation { self.waiting[id] = $0 }
    }

    func deliver(_ input: NodeInvokeInputEvent) {
        if let pending = waiting.removeValue(forKey: input.id) { pending.resume(returning: input.payloadjson) }
        else { self.buffered[input.id] = input.payloadjson }
    }
}

@main struct FunctionalProbe {
    static func main() async throws {
        let url = URL(string: CommandLine.arguments[1])!
        let session = GatewayNodeSession()
        let inbox = InputInbox()
        let mode = CommandLine.arguments[2]
        let transport: any WebSocketSessioning
        if mode == "baseline" {
            transport = URLSession(configuration: .ephemeral)
        } else if mode == "bundled" {
            transport = RustGatewayWebSocketSession(
                executableURL: RustGatewayWebSocketSession.bundledExecutableURL)
        } else {
            transport = RustGatewayWebSocketSession(executableURL: URL(fileURLWithPath: mode))
        }
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["benchmark"],
            commands: ["benchmark.echo", "benchmark.raw", "system.echo", "benchmark.duplex", "system.notify"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "RFC54 functional probe",
            includeDeviceIdentity: false,
            allowStoredDeviceAuth: false)
        do {
            try await session.connect(
                url: url,
                token: "benchmark-token",
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: transport),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                if req.id == "retire-during-delivery" {
                    print("{\"nativeEntered\":\"\(req.id)\"}")
                    fflush(stdout)
                    let release = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                        .appendingPathComponent("retirement-release-\(req.id)")
                    while !FileManager.default.fileExists(atPath: release.path) {
                        // Ignore cancellation until the harness releases the handoff so the
                        // production notification boundary, rather than sleep, proves rejection.
                        try? await Task.sleep(for: .milliseconds(5))
                    }
                    do {
                        try NotificationDeliveryFence.perform {
                            print("{\"nativeEffect\":\"\(req.id)\"}")
                            fflush(stdout)
                        }
                    } catch is CancellationError {
                        print("{\"nativeRejectedBeforeEffect\":\"\(req.id)\"}")
                        fflush(stdout)
                        return BridgeInvokeResponse(
                            id: req.id,
                            ok: false,
                            error: OpenClawNodeError(
                                code: .unavailable,
                                message: "native operation retired before effect"))
                    } catch {
                        print("{\"nativeFenceError\":\"\\(error)\"}")
                        fflush(stdout)
                        return BridgeInvokeResponse(
                            id: req.id,
                            ok: false,
                            error: OpenClawNodeError(
                                code: .unavailable,
                                message: "native effect fence failed"))
                    }
                    return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: "{}")
                }
                if req.command == "benchmark.duplex" || req.command == "system.notify" {
                    do {
                        _ = try await session.request(
                            method: "node.invoke.progress",
                            params: [
                                "invokeId": AnyCodable(req.id),
                                "nodeId": AnyCodable(req.nodeId!),
                                "seq": AnyCodable(0),
                                "chunk": AnyCodable("native-start"),
                            ])
                        if req.command == "benchmark.duplex" {
                            let payload = await inbox.take(req.id)
                            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
                        }
                        try await Task.sleep(for: .seconds(30))
                        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: "{}")
                    } catch {
                        print("{\"nativeCancelled\":\"\(req.id)\"}")
                        fflush(stdout)
                        return BridgeInvokeResponse(
                            id: req.id,
                            ok: false,
                            error: OpenClawNodeError(code: .unavailable, message: "native operation cancelled"))
                    }
                }
                if req.command == "benchmark.raw" { return BridgeInvokeResponse(
                    id: req.id,
                    ok: true,
                    payload: AnyCodable(["present": req.paramsJSON != nil, "raw": req.paramsJSON ?? "missing"])) }
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: req.paramsJSON)
                },
                onInvokeInput: { event in await inbox.deliver(event) },
                onInvokeCancel: { id in
                    print("{\"nativeCancelEvent\":\"\(id)\"}")
                    fflush(stdout)
                },
                onRouteInvalidated: {
                    print("{\"nativeRouteRetired\":true}")
                    fflush(stdout)
                })
        } catch {
            let failure = error as NSError
            let record: [String: Any] = [
                "startupFailure": ["domain": failure.domain, "code": failure.code],
            ]
            let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            print(String(decoding: data, as: UTF8.self))
            fflush(stdout)
            throw error
        }
        print("{\"ready\":true,\"pid\":\(ProcessInfo.processInfo.processIdentifier)}")
        fflush(stdout)
        while readLine() != nil {}
        await session.disconnect()
    }
}
