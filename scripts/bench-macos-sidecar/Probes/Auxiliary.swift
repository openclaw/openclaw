import Foundation
import OpenClawKit
import OpenClawProtocol

#if canImport(OpenClawRustSidecar)
import OpenClawRustSidecar
#endif
@main struct AuxiliaryProbe {
    static func main() async throws {
        let url = URL(string: CommandLine.arguments[1])!
        let session = GatewayNodeSession()
        #if canImport(OpenClawRustSidecar)
        let transport: any WebSocketSessioning = RustGatewayWebSocketSession(
            executableURL: URL(fileURLWithPath: CommandLine.arguments[2]))
        #else
        let transport: any WebSocketSessioning = URLSession(configuration: .ephemeral)
        #endif
        let options = GatewayConnectOptions(
            role: "node", scopes: [], caps: [], commands: ["benchmark.echo"], permissions: [:],
            clientId: "openclaw-macos", clientMode: "node", clientDisplayName: "RFC54 RPC probe",
            includeDeviceIdentity: false, allowStoredDeviceAuth: false)
        let postHello = await session.makeServerEventSubscription(bufferingNewest: 1) {
            $0.event == "benchmark.post-hello"
        }
        var checks: [[String: Any]] = []
        do {
            try await session.connect(
                url: url, token: "benchmark-token", connectOptions: options,
                sessionBox: WebSocketSessionBox(session: transport), onConnected: {},
                onDisconnected: { _ in }, onInvoke: { r in BridgeInvokeResponse(id: r.id, ok: true) })
            print("{\"ready\":true}")
            fflush(stdout)
            var postHelloEvents = postHello.events.makeAsyncIterator()
            guard await postHelloEvents.next() != nil else { throw URLError(.networkConnectionLost) }
            postHello.cancel()
            checks.append([
                "scenario": "event immediately after hello reaches pre-connect subscriber",
                "passed": true,
            ])
            if !CommandLine.arguments.contains("capacity") {
                let start = ContinuousClock.now
                let data = try await session.request(
                    method: "benchmark.delay", params: ["delayMs": AnyCodable(31000)], timeoutMs: 0)
                let elapsed = start.duration(to: .now)
                let seconds =
                    Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
                guard seconds > 30,
                      try (JSONSerialization.jsonObject(with: data) as? [String: Any])?["delayed"] as? Bool
                      == true
                else { throw URLError(.badServerResponse) }
                checks.append([
                    "scenario": "caller timeout0 survives31s", "elapsedSeconds": seconds, "passed": true,
                ])
                do {
                    _ = try await session.request(method: "benchmark.never", params: nil, timeoutMs: 100)
                    throw URLError(.badServerResponse)
                } catch { guard error.localizedDescription.contains("timed out") else { throw error } }
                checks.append(["scenario": "finite native RPC timeout remains enforced", "passed": true])
                for batch in 0..<2 {
                    let subscription = await session.makeServerEventSubscription(matching: {
                        $0.event == "benchmark.batch-ready"
                    })
                    let tasks = (0..<64).map { slot in
                        Task {
                            try await session.request(
                                method: "benchmark.never",
                                params: ["batch": AnyCodable(batch), "slot": AnyCodable(slot)], timeoutMs: 0)
                        }
                    }
                    var iterator = subscription.events.makeAsyncIterator()
                    guard await iterator.next() != nil else { throw URLError(.networkConnectionLost) }
                    for task in tasks {
                        task.cancel()
                    }
                    for task in tasks {
                        do {
                            _ = try await task.value
                            throw URLError(.badServerResponse)
                        } catch is CancellationError {} catch { throw error }
                    }
                    subscription.cancel()
                    let echo = try await session.request(
                        method: "benchmark.echo", params: ["batch": AnyCodable(batch)], timeoutMs: 2000)
                    guard
                        try (JSONSerialization.jsonObject(with: echo) as? [String: Any])?["batch"] as? Int
                        == batch
                    else { throw URLError(.badServerResponse) }
                    checks.append([
                        "scenario": "64cancelled RPCs release capacity; same session reusable", "batch": batch,
                        "passed": true,
                    ])
                }
            }
            let batches =
                CommandLine.arguments.contains("capacity")
                ? (Int(CommandLine.arguments.last ?? "") ?? 10) : 10
            for batch in 2..<(2 + batches) {
                let subscription = await session.makeServerEventSubscription(matching: {
                    $0.event == "benchmark.batch-ready"
                })
                let tasks = (0..<64).map { slot in
                    Task {
                        try await session.request(
                            method: "benchmark.never",
                            params: ["batch": AnyCodable(batch), "slot": AnyCodable(slot)], timeoutMs: 0)
                    }
                }
                defer { for task in tasks {
                    task.cancel()
                } }
                var iterator = subscription.events.makeAsyncIterator()
                guard await iterator.next() != nil else { throw URLError(.networkConnectionLost) }
                subscription.cancel()
                if batch == 2 {
                    try await Task.sleep(for: .seconds(17))
                    checks.append([
                        "scenario": "64 pending RPCs survive a keepalive interval",
                        "passed": true,
                    ])
                }
                tasks[0].cancel()
                do {
                    _ = try await tasks[0].value
                    throw URLError(.badServerResponse)
                } catch is CancellationError {}
                let echo = try await session.request(
                    method: "benchmark.echo", params: ["batch": AnyCodable(batch)], timeoutMs: 2000)
                guard
                    try (JSONSerialization.jsonObject(with: echo) as? [String: Any])?["batch"] as? Int
                    == batch
                else { throw URLError(.badServerResponse) }
                checks.append([
                    "scenario": "one of 64 cancelled RPCs releases capacity while 63 remain", "batch": batch,
                    "passed": true,
                ])
                for task in tasks.dropFirst() {
                    task.cancel()
                }
                for task in tasks.dropFirst() {
                    do {
                        _ = try await task.value
                        throw URLError(.badServerResponse)
                    } catch is CancellationError {}
                }
            }
            let result: [String: Any] = ["checks": checks, "passed": true]
            let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(decoding: json, as: UTF8.self))
            fflush(stdout)
        } catch {
            let result: [String: Any] = [
                "checks": checks, "passed": false, "error": error.localizedDescription,
            ]
            let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(decoding: json, as: UTF8.self))
            fflush(stdout)
        }
        await session.disconnect()
    }
}
