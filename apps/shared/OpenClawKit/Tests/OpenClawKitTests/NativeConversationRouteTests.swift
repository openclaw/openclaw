import Foundation
import OpenClawChatUI
import OpenClawKit
import Testing

@MainActor
struct NativeConversationRouteTests {
    @Test(arguments: [true, false])
    func `newer web route wins while the earlier reservation is pending`(acceptEarlier: Bool) async throws {
        let original = NativeConversationContext(agentId: "main", sessionKey: "agent:main:a")
        let earlier = NativeConversationContext(agentId: "main", sessionKey: "agent:main:b")
        let latest = NativeConversationContext(agentId: "main", sessionKey: "agent:main:c")
        let routes = OpenClawWebConversation.RouteReconciliation()
        let ownership = OpenClawChatSendOwnership()
        let window = UUID()
        func scope(_ context: NativeConversationContext) -> OpenClawChatSendOwnership.Scope {
            .init(sessionKey: context.sessionKey, agentID: context.agentId)
        }
        defer {
            ownership.endWeb(scope(earlier), owner: window)
            ownership.endWeb(scope(latest), owner: window)
        }
        var selected = original
        var attempts: [NativeConversationContext] = []
        var releaseEarlier: CheckedContinuation<Bool, Never>?
        let (started, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        routes.report(earlier)
        let transition = Task {
            defer { continuation.finish() }
            return await routes.reconcile(
                isCurrent: { true },
                reserve: { context in
                    attempts.append(context)
                    let accepted: Bool = if context == earlier {
                        await withCheckedContinuation {
                            releaseEarlier = $0
                            continuation.yield(())
                        }
                    } else {
                        true
                    }
                    return accepted && ownership.beginWeb(scope(context), owner: window)
                },
                select: { selected = $0 })
        }
        var arrivals = started.makeAsyncIterator()
        await arrivals.next()
        routes.report(latest)
        try #require(releaseEarlier).resume(returning: acceptEarlier)
        let outcome = await transition.value
        #expect(outcome == .selected(latest))
        #expect(selected == latest)
        #expect(attempts == [earlier, latest])
        let nativeAdmitted = ownership.beginNative(scope(latest))
        #expect(!nativeAdmitted)
        if nativeAdmitted { ownership.endNative(scope(latest)) }
    }
}
