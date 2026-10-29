import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct RootEventSubscriptionTests {
    @Test(arguments: [false, true])
    func `root event subscriptions keep owner events through unrelated chat bursts`(operatorEvents: Bool) async {
        let gateway = GatewayNodeSession()
        let subscription = if operatorEvents {
            await NodeAppModel.makeOperatorEventSubscription(gateway: gateway)
        } else {
            await RootSidebarModel.makeSessionEventSubscription(gateway: gateway)
        }
        let expectedEvents = operatorEvents
            ? [
                "config.changed", "users.prefs.changed", "voicewake.changed", "talk.mode",
                "exec.approval.requested", "plugin.approval.requested", "openclaw.approval.requested",
                "exec.approval.resolved", "plugin.approval.resolved", "openclaw.approval.resolved",
            ]
            : ["sessions.changed", "session.observer", "seqGap"]
        for event in expectedEvents {
            await gateway._test_broadcastServerEvent(EventFrame(type: "event", event: event))
        }
        // Exceed the production 200-frame buffer before consuming. The former
        // all-event subscription evicts every owner event and retains only noise.
        let unrelatedPayload = AnyCodable(["text": String(repeating: "x", count: 65536)])
        let unrelatedEvents = ["chat", "session.message", "agent", "progressCard.changed", "tick"]
        for index in 0..<500 {
            await gateway._test_broadcastServerEvent(EventFrame(
                type: "event",
                event: unrelatedEvents[index % unrelatedEvents.count],
                payload: unrelatedPayload))
        }
        // Other root owners must not compete for this consumer's buffer either.
        await gateway._test_broadcastServerEvent(EventFrame(
            type: "event", event: operatorEvents ? "sessions.changed" : "voicewake.changed"))
        subscription.cancel()

        var receivedEvents: [String] = []
        for await frame in subscription.events {
            receivedEvents.append(frame.event)
        }
        #expect(receivedEvents == expectedEvents)
    }
}
