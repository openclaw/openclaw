import Foundation
import OpenClawChatUI
import Testing

struct NativeConversationOwnershipTests {
    @Test func `case variants cannot bypass an existing conversation owner`() {
        for (webKey, nativeKey, agentID) in [
            ("agent:research:dashboard:abc", " AGENT:Research:Dashboard:ABC ", "research"),
            ("global", " GLOBAL ", "research"),
            ("agent:research:slack:channel:c1:thread:abc", "Agent:Research:Slack:Channel:C1:Thread:ABC", "research"),
        ] {
            let ownership = OpenClawChatSendOwnership()
            let web = OpenClawChatSendOwnership.Scope(sessionKey: webKey, agentID: agentID)
            let native = OpenClawChatSendOwnership.Scope(sessionKey: nativeKey, agentID: agentID)
            let window = UUID()
            #expect(ownership.beginWeb(web, owner: window))
            #expect(!ownership.beginNative(native))
            ownership.endWeb(web, owner: window)
        }
    }

    @Test func `structural case aliases preserve distinct opaque Signal and Matrix identifiers`() {
        for (webKey, aliasKey, distinctKey) in [
            (
                "agent:research:signal:group:AbC123=:thread:xyz",
                "Agent:Research:Signal:Group:AbC123=:Thread:XYZ",
                "agent:research:signal:group:abc123=:thread:xyz"),
            (
                "agent:research:matrix:channel:!Room:Example.Org:thread:$Event:Example.Org",
                "Agent:Research:Matrix:Channel:!Room:Example.Org:Thread:$Event:Example.Org",
                "agent:research:matrix:channel:!room:Example.Org:thread:$Event:Example.Org"),
            (
                "agent:research:matrix:group:!Room:Example.Org:thread:$Event:Example.Org",
                "Agent:Research:Matrix:Group:!Room:Example.Org:THREAD:$Event:Example.Org",
                "agent:research:matrix:group:!Room:Example.Org:thread:$event:Example.Org"),
            (
                "agent:research:agent:other:matrix:channel:!Room:Example.Org:thread:$Event",
                "Agent:Research:Agent:Other:Matrix:Channel:!Room:Example.Org:THREAD:$Event",
                "agent:research:agent:other:matrix:channel:!room:Example.Org:thread:$Event"),
            (
                "agent:research:matrix:channel:!Room:Example.Org:Signal:Group: AbC :thread:$Event:Signal:Group: XyZ",
                "Agent:Research:Matrix:Channel:!Room:Example.Org:Signal:Group: AbC :THREAD:$Event:Signal:Group: XyZ",
                "agent:research:matrix:channel:!Room:Example.Org:signal:group: abc :thread:$Event:signal:group: xyz"),
        ] {
            let ownership = OpenClawChatSendOwnership()
            let web = OpenClawChatSendOwnership.Scope(sessionKey: webKey, agentID: nil)
            let alias = OpenClawChatSendOwnership.Scope(sessionKey: aliasKey, agentID: nil)
            let distinct = OpenClawChatSendOwnership.Scope(sessionKey: distinctKey, agentID: nil)
            let window = UUID()
            #expect(ownership.beginWeb(web, owner: window))
            #expect(!ownership.beginNative(alias))
            #expect(ownership.beginNative(distinct))
            ownership.endNative(distinct)
            ownership.endWeb(web, owner: window)
        }
    }

    @Test func `published routing metadata unifies nondefault agent main aliases`() {
        for routingScope in ["global", "per-sender"] {
            let canonical = routingScope == "global" ? "global" : "agent:research:workspace"
            for alias in ["MAIN", "Workspace", "Agent:Research:Main", "AGENT:Research:Workspace"] {
                let ownership = OpenClawChatSendOwnership()
                let web = OpenClawChatSendOwnership.Scope(
                    sessionKey: canonical, agentID: "research", scope: routingScope,
                    mainKey: "workspace", defaultAgentID: "main")
                let native = OpenClawChatSendOwnership.Scope(
                    sessionKey: alias, agentID: "research", scope: routingScope,
                    mainKey: "workspace", defaultAgentID: "main")
                let window = UUID()
                #expect(ownership.beginWeb(web, owner: window))
                #expect(!ownership.beginNative(native))
                ownership.endWeb(web, owner: window)
            }
        }
    }

    @Test func `default owner resolution keeps explicit agents and qualified global sessions distinct`() {
        let ownership = OpenClawChatSendOwnership()
        let window = UUID()
        let global = OpenClawChatSendOwnership.Scope(
            sessionKey: "global", agentID: "research", scope: "global", mainKey: "workspace",
            defaultAgentID: "research")
        let defaultMain = OpenClawChatSendOwnership.Scope(
            sessionKey: "main", agentID: nil, scope: "global", mainKey: "workspace",
            defaultAgentID: "research")
        let qualifiedGlobal = OpenClawChatSendOwnership.Scope(
            sessionKey: "agent:research:global", agentID: nil, scope: "global", mainKey: "workspace",
            defaultAgentID: "research")
        let otherAgent = OpenClawChatSendOwnership.Scope(
            sessionKey: "agent:main:workspace", agentID: nil, scope: "global", mainKey: "workspace",
            defaultAgentID: "research")
        #expect(ownership.beginWeb(global, owner: window))
        #expect(!ownership.beginNative(defaultMain))
        #expect(ownership.beginNative(qualifiedGlobal))
        #expect(ownership.beginNative(otherAgent))
        ownership.endNative(qualifiedGlobal)
        ownership.endNative(otherAgent)
        ownership.endWeb(global, owner: window)
    }

    @Test func `bare sentinels remain distinct when the custom main key has the same spelling`() {
        for sentinel in ["global", "unknown"] {
            let ownership = OpenClawChatSendOwnership()
            let web = OpenClawChatSendOwnership.Scope(
                sessionKey: sentinel, agentID: "research", scope: "per-sender", mainKey: sentinel,
                defaultAgentID: "main")
            let qualified = OpenClawChatSendOwnership.Scope(
                sessionKey: "agent:research:\(sentinel)", agentID: nil, scope: "per-sender", mainKey: sentinel,
                defaultAgentID: "main")
            let window = UUID()
            #expect(ownership.beginWeb(web, owner: window))
            #expect(ownership.beginNative(qualified))
            ownership.endNative(qualified)
            ownership.endWeb(web, owner: window)
        }
    }

    @Test func `native work retains ownership until every in-flight claim settles`() {
        let ownership = OpenClawChatSendOwnership()
        let scope = OpenClawChatSendOwnership.Scope(sessionKey: "agent:main:thread", agentID: nil)
        let window = UUID()
        #expect(ownership.beginNative(scope))
        #expect(ownership.beginNative(scope))
        #expect(!ownership.beginWeb(scope, owner: window))
        ownership.endNative(scope)
        #expect(!ownership.beginWeb(scope, owner: window))
        ownership.endNative(scope)
        #expect(ownership.beginWeb(scope, owner: window))
        #expect(!ownership.beginNative(scope))
        ownership.endWeb(scope, owner: window)
        #expect(ownership.beginNative(scope))
        ownership.endNative(scope)
    }

    @Test func `two web windows release their own claims independently`() {
        let ownership = OpenClawChatSendOwnership()
        let scope = OpenClawChatSendOwnership.Scope(sessionKey: "agent:main:thread", agentID: nil)
        let first = UUID()
        let second = UUID()
        #expect(ownership.beginWeb(scope, owner: first))
        #expect(ownership.beginWeb(scope, owner: first))
        #expect(ownership.beginWeb(scope, owner: second))
        ownership.endWeb(scope, owner: UUID())
        #expect(!ownership.beginNative(scope))
        ownership.endWeb(scope, owner: first)
        #expect(!ownership.beginNative(scope))
        ownership.endWeb(scope, owner: first)
        #expect(!ownership.beginNative(scope))
        ownership.endWeb(scope, owner: second)
        #expect(ownership.beginNative(scope))
        ownership.endNative(scope)
    }

    @Test func `global sessions remain partitioned by agent without blocking unrelated sessions`() {
        let ownership = OpenClawChatSendOwnership()
        let main = OpenClawChatSendOwnership.Scope(sessionKey: "global", agentID: "MAIN")
        let same = OpenClawChatSendOwnership.Scope(sessionKey: "global", agentID: "main")
        let research = OpenClawChatSendOwnership.Scope(sessionKey: "global", agentID: "research")
        let otherThread = OpenClawChatSendOwnership.Scope(sessionKey: "agent:main:other", agentID: nil)
        let window = UUID()
        #expect(ownership.beginWeb(main, owner: window))
        #expect(!ownership.beginNative(same))
        #expect(ownership.beginNative(research))
        #expect(ownership.beginNative(otherThread))
        ownership.endNative(research)
        ownership.endNative(otherThread)
        ownership.endWeb(main, owner: window)
        #expect(ownership.beginNative(same))
        ownership.endNative(same)
    }
}
