import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

extension VoiceWakeGlobalSettingsSyncTests {
    // Reload waits have no deadline of their own; the limit only bounds a lost reload.
    @Test(.timeLimit(.minutes(2)), arguments: [false, true])
    func `new primary connection reloads its current voice wake triggers`(switchGateway: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            let previous = AppStateStore.shared.swabbleTriggerWords
            defer { AppStateStore.shared.applyGlobalVoiceWakeTriggers(previous) }
            let port = LockIsolated(49260)
            let triggers = LockIsolated("gateway-a")
            let session = GatewayTestWebSocketSession {
                GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                    guard sendIndex > 0 else { return }
                    let data: Data
                    switch message {
                    case let .data(value): data = value
                    case let .string(value): data = Data(value.utf8)
                    @unknown default: return
                    }
                    guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let id = frame["id"] as? String,
                          let method = frame["method"] as? String
                    else { return }
                    let payload: String
                    if method == "voicewake.get" {
                        let value = triggers.value
                        payload = #"{"triggers":["\#(value)"]}"#
                    } else {
                        payload = #"{"ok":true}"#
                    }
                    let response = #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#
                    socket.emitReceiveSuccess(.data(Data(response.utf8)))
                })
            }
            let gateway = GatewayConnection(
                configProvider: {
                    (url: URL(string: "ws://127.0.0.1:\(port.value)")!, token: nil, password: nil)
                },
                sessionBox: WebSocketSessionBox(session: session))
            let sync = VoiceWakeGlobalSettingsSync(gateway: gateway)
            sync.start()
            do {
                try await self.waitForTriggers(["gateway-a"])
                await gateway.shutdown()
                if switchGateway { port.setValue(49261) }
                triggers.setValue("gateway-b")
                _ = try await gateway.acquireServerLease()
                try await self.waitForTriggers(["gateway-b"])
            } catch {
                sync.stop()
                await gateway.shutdown()
                throw error
            }
            sync.stop()
            await gateway.shutdown()
        }
    }

    /// Each reload crosses the connection actor and the fake socket before it lands
    /// on the main actor. Wait on the observed triggers, not a wall-clock deadline
    /// that native-suite load can exceed.
    private func waitForTriggers(_ expected: [String]) async throws {
        while true {
            try Task.checkCancellation()
            let changed = AsyncTestGate()
            let ready = withObservationTracking {
                AppStateStore.shared.swabbleTriggerWords == expected
            } onChange: {
                changed.open()
            }
            if ready { return }
            await changed.wait()
        }
    }
}
