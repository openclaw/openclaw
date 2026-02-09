import EasyHubChatUI
import EasyHubProtocol
import Testing
@testable import EasyHub

@Suite struct MacGatewayChatTransportMappingTests {
    @Test func snapshotMapsToHealth() {
        let snapshot = Snapshot(
            presence: [],
            health: EasyHubProtocol.AnyCodable(["ok": EasyHubProtocol.AnyCodable(false)]),
            stateversion: StateVersion(presence: 1, health: 1),
            uptimems: 123,
            configpath: nil,
            statedir: nil,
            sessiondefaults: nil)

        let hello = HelloOk(
            type: "hello",
            _protocol: 2,
            server: [:],
            features: [:],
            snapshot: snapshot,
            canvashosturl: nil,
            auth: nil,
            policy: [:])

        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.snapshot(hello))
        switch mapped {
        case let .health(ok):
            #expect(ok == false)
        default:
            Issue.record("expected .health from snapshot, got \(String(describing: mapped))")
        }
    }

    @Test func healthEventMapsToHealth() {
        let frame = EventFrame(
            type: "event",
            event: "health",
            payload: EasyHubProtocol.AnyCodable(["ok": EasyHubProtocol.AnyCodable(true)]),
            seq: 1,
            stateversion: nil)

        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        switch mapped {
        case let .health(ok):
            #expect(ok == true)
        default:
            Issue.record("expected .health from health event, got \(String(describing: mapped))")
        }
    }

    @Test func tickEventMapsToTick() {
        let frame = EventFrame(type: "event", event: "tick", payload: nil, seq: 1, stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        #expect({
            if case .tick = mapped { return true }
            return false
        }())
    }

    @Test func chatEventMapsToChat() {
        let payload = EasyHubProtocol.AnyCodable([
            "runId": EasyHubProtocol.AnyCodable("run-1"),
            "sessionKey": EasyHubProtocol.AnyCodable("main"),
            "state": EasyHubProtocol.AnyCodable("final"),
        ])
        let frame = EventFrame(type: "event", event: "chat", payload: payload, seq: 1, stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))

        switch mapped {
        case let .chat(chat):
            #expect(chat.runId == "run-1")
            #expect(chat.sessionKey == "main")
            #expect(chat.state == "final")
        default:
            Issue.record("expected .chat from chat event, got \(String(describing: mapped))")
        }
    }

    @Test func unknownEventMapsToNil() {
        let frame = EventFrame(
            type: "event",
            event: "unknown",
            payload: EasyHubProtocol.AnyCodable(["a": EasyHubProtocol.AnyCodable(1)]),
            seq: 1,
            stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        #expect(mapped == nil)
    }

    @Test func seqGapMapsToSeqGap() {
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.seqGap(expected: 1, received: 9))
        #expect({
            if case .seqGap = mapped { return true }
            return false
        }())
    }
}
