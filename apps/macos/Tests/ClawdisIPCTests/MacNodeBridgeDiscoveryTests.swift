import Foundation
import Network
import Testing
@testable import Clawdis

@Suite struct MacNodeBridgeDiscoveryTests {
    @MainActor
    @Test func loopbackBridgePortDefaultsAndOverrides() {
        withEnv("CLAWDIS_BRIDGE_PORT", value: nil) {
            #expect(MacNodeModeCoordinator.loopbackBridgePort() == 18790)
        }
        withEnv("CLAWDIS_BRIDGE_PORT", value: "19991") {
            #expect(MacNodeModeCoordinator.loopbackBridgePort() == 19991)
        }
        withEnv("CLAWDIS_BRIDGE_PORT", value: "not-a-port") {
            #expect(MacNodeModeCoordinator.loopbackBridgePort() == 18790)
        }
    }

    @MainActor
    @Test func probeEndpointSucceedsForOpenPort() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { connection in
            connection.cancel()
        }
        listener.start(queue: DispatchQueue(label: "com.steipete.clawdis.tests.bridge-listener"))
        try await waitForListenerReady(listener, timeoutSeconds: 1.0)

        guard let port = listener.port else {
            listener.cancel()
            throw TestError(message: "listener port missing")
        }

        let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        let ok = await MacNodeModeCoordinator.probeEndpoint(endpoint, timeoutSeconds: 0.6)
        listener.cancel()
        #expect(ok == true)
    }

    @MainActor
    @Test func probeEndpointFailsForClosedPort() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        listener.start(queue: DispatchQueue(label: "com.steipete.clawdis.tests.bridge-listener-close"))
        try await waitForListenerReady(listener, timeoutSeconds: 1.0)
        let port = listener.port
        listener.cancel()
        try await Task.sleep(nanoseconds: 150_000_000)

        guard let port else {
            throw TestError(message: "listener port missing")
        }

        let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        let ok = await MacNodeModeCoordinator.probeEndpoint(endpoint, timeoutSeconds: 0.4)
        #expect(ok == false)
    }
}

private struct TestError: Error {
    let message: String
}

private struct ListenerTimeoutError: Error {}

private func waitForListenerReady(_ listener: NWListener, timeoutSeconds: Double) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask {
            try await withCheckedThrowingContinuation { cont in
                final class ListenerState: @unchecked Sendable {
                    let lock = NSLock()
                    var finished = false
                }
                let state = ListenerState()
                let finish: @Sendable (Result<Void, Error>) -> Void = { result in
                    state.lock.lock()
                    defer { state.lock.unlock() }
                    guard !state.finished else { return }
                    state.finished = true
                    cont.resume(with: result)
                }

                listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        finish(.success(()))
                    case .failed(let err):
                        finish(.failure(err))
                    case .cancelled:
                        finish(.failure(ListenerTimeoutError()))
                    default:
                        break
                    }
                }
            }
        }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            throw ListenerTimeoutError()
        }
        _ = try await group.next()
        group.cancelAll()
    }
}

private func withEnv(_ key: String, value: String?, _ body: () -> Void) {
    let existing = getenv(key).map { String(cString: $0) }
    if let value {
        setenv(key, value, 1)
    } else {
        unsetenv(key)
    }
    defer {
        if let existing {
            setenv(key, existing, 1)
        } else {
            unsetenv(key)
        }
    }
    body()
}
