import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatGatewayAgentCatalogTests {
    @Test func `unnamed roster agents retain their id until an identity arrives`() throws {
        let data = Data(#"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main"}]}"#.utf8)
        let catalog = try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data)
        #expect(catalog.agents.first?.displayName == "main")
    }

    @Test func `identity requests target the listed agent without a session alias`() {
        let request = OpenClawChatGatewayRequests.agentIdentity(agentID: " research ")
        #expect(request.method == "agent.identity.get")
        #expect(request.params == ["agentId": AnyCodable("research")])
    }

    @Test(arguments: [
        (" ", "main"),
        (" Research ", "Research"),
        (String(repeating: "x", count: 51), String(repeating: "x", count: 50)),
        (String(repeating: "x", count: 49) + "🦞", String(repeating: "x", count: 49)),
        (String(repeating: "🦞", count: 26), String(repeating: "🦞", count: 25)),
    ])
    func `names match the web normalization bound`(name: String, expected: String) {
        #expect(OpenClawChatAgentChoice(id: "main", name: name).displayName == expected)
    }

    @Test(arguments: [
        (" 🦞 ", Optional("🦞")),
        ("PS", Optional("PS")),
        (String(repeating: "x", count: 64), Optional(String(repeating: "x", count: 64))),
        (String(repeating: "🦞", count: 33), nil),
        ("A\nB", nil),
        ("A\rB", nil),
        ("data:image/png;base64,YQ==", nil),
        ("/avatar/main", nil),
        ("//example.test/avatar.png", nil),
        ("https://example.test/avatar.png", nil),
        ("file:///avatar.png", nil),
        ("blob:avatar", nil),
    ])
    func `text avatars remain bounded and never render image locations as glyphs`(
        avatar: String,
        expected: String?)
    {
        let agent = OpenClawChatAgentChoice(id: "main", name: "Research", emoji: avatar)
        #expect(agent.emoji == expected)
    }

    @Test(arguments: [("Research", "Re"), ("👩🏽‍💻🇦🇹🦞", "👩🏽‍💻🇦🇹"), ("🦞", "🦞")])
    func `badges clamp text to two complete graphemes`(avatar: String, expected: String) {
        let agent = OpenClawChatAgentChoice(id: "main", emoji: avatar)
        #expect(agent.emoji == avatar)
        #expect(agent.avatarText == expected)
    }

    @Test func `picker is usable before identity responses and updates without resetting selection`() async {
        let options = ChatNewSessionAgentOptions()
        let lease = OpenClawChatNewSessionRouteLease(
            loadAgents: { onUpdate in
                try await OpenClawChatAgentsListResponse.load(
                    request: { request in
                        if request.method == "agents.list" {
                            return Data(
                                #"""
                                {"defaultId":"main","mainKey":"main","scope":"per-sender",
                                 "agents":[{"id":"main"},{"id":"ops","name":"Operations"}]}
                                """#
                                    .utf8)
                        }
                        // No identity response has been returned when the picker first becomes usable.
                        await MainActor.run {
                            #expect(!options.isLoading)
                            #expect(options.routeLease != nil)
                            #expect(options.agents.map(\.id) == ["main", "ops"])
                            #expect(options.agents.last?.displayName == "Operations")
                            options.selectedAgentID = "ops"
                        }
                        let id = try #require(request.params["agentId"]?.value as? String)
                        return try JSONEncoder().encode(AgentIdentityResult(
                            agentid: id, name: "Assistant", avatar: "A"))
                    },
                    isCurrent: { true },
                    onUpdate: onUpdate)
            },
            createSession: { key, _, _, _, _, _ in .init(ok: true, key: key, sessionId: nil) })

        await options.load(selectedAgentID: "main") { lease }

        #expect(options.agents.map(\.displayName) == ["Assistant", "Operations"])
        #expect(options.selectedAgentID == "ops")
        #expect(!options.isLoading)
        #expect(options.errorText == nil)
    }

    @Test func `retired connection drops identity updates and disables picker creation`() async {
        actor Route {
            var current = true
            func retire() {
                self.current = false
            }
        }
        let route = Route()
        let options = ChatNewSessionAgentOptions()
        let lease = OpenClawChatNewSessionRouteLease(
            loadAgents: { onUpdate in
                try await OpenClawChatAgentsListResponse.load(
                    request: { request in
                        if request.method == "agents.list" {
                            return Data(
                                #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main"}]}"#
                                    .utf8)
                        }
                        await MainActor.run {
                            #expect(!options.isLoading)
                            #expect(options.agents.first?.displayName == "main")
                        }
                        await route.retire()
                        return try JSONEncoder().encode(AgentIdentityResult(agentid: "main", name: "Retired"))
                    },
                    isCurrent: { await route.current },
                    onUpdate: onUpdate)
            },
            createSession: { key, _, _, _, _, _ in .init(ok: true, key: key, sessionId: nil) })

        await options.load(selectedAgentID: "main") { lease }
        #expect(options.routeLease == nil)
        #expect(options.agents.isEmpty)
        #expect(!options.isLoading)
    }

    @Test func `catalog hydration preserves configured identity routing and roster order`() async throws {
        var updates: [OpenClawChatAgentsListResponse] = []
        try await OpenClawChatAgentsListResponse.load(
            request: { request in
                if request.method == "agents.list" {
                    #expect(request.params.isEmpty)
                    return Data(
                        #"""
                        {"defaultId":"main","mainKey":"inbox","scope":"global","agents":[\#
                        {"id":"main"},\#
                        {"id":"ops","name":" Operations ",\#
                        "identity":{"name":"Ignored","emoji":"🛠️"},"workspaceGit":true},\#
                        {"id":"research","name":" ","identity":{"name":" Research ","avatar":"RS"}},\#
                        {"id":"system","kind":"system"}]}
                        """#
                            .utf8)
                }
                #expect(request.method == "agent.identity.get")
                let id = try #require(request.params["agentId"]?.value as? String)
                #expect(["main", "ops", "research"].contains(id))
                return try JSONEncoder().encode(AgentIdentityResult(
                    agentid: id, name: "Assistant", namesource: "default", avatar: "A"))
            },
            isCurrent: { true },
            onUpdate: { if let catalog = $0 { updates.append(catalog) } })

        let catalog = try #require(updates.last)
        #expect(updates.first?.agents.map(\.displayName) == ["main", "Operations", "Research"])
        #expect(catalog.defaultId == "main")
        #expect(catalog.sessionRoutingContract == "global|inbox|main")
        #expect(catalog.agents.map(\.id) == ["main", "ops", "research"])
        #expect(catalog.agents.map(\.displayName) == ["Assistant", "Operations", "Research"])
        #expect(catalog.agents.map(\.avatarText) == ["A", "🛠️", "RS"])
        #expect(catalog.agents[1].workspaceGit == true)
    }

    @Test(arguments: [
        ("/control/avatar/research?v=2", "research", "/control/avatar/research?v=2"),
        ("data:image/png;base64,Yg==", "research", "data:image/png;base64,Yg=="),
        ("PS", "research", "data:image/png;base64,YQ=="),
        ("https://example.test/avatar.png", "research", "data:image/png;base64,YQ=="),
        ("/avatar/other", "other", "data:image/png;base64,YQ=="),
    ])
    func `published catalogs preserve image sources without changing text avatars`(
        resolvedAvatar: String, identityAgent: String, expectedAvatar: String) async throws
    {
        var updates: [OpenClawChatAgentsListResponse] = []
        try await OpenClawChatAgentsListResponse.load(
            request: { request in
                if request.method == "agents.list" {
                    return Data(
                        #"""
                        {"defaultId":"research","mainKey":"main","scope":"per-sender",
                         "agents":[{"id":"research","identity":{"emoji":"RS","avatar":"/avatar/stale",
                         "avatarUrl":"data:image/png;base64,YQ=="}}]}
                        """#
                            .utf8)
                }
                return try JSONEncoder().encode(AgentIdentityResult(
                    agentid: identityAgent, name: "Research", avatar: resolvedAvatar))
            },
            isCurrent: { true },
            onUpdate: { if let catalog = $0 { updates.append(catalog) } })

        // Inspect the delivered payload so this regression also executes against the pre-image catalog.
        for (catalog, expected) in try [
            (#require(updates.first), "data:image/png;base64,YQ=="),
            (#require(updates.last), expectedAvatar),
        ] {
            let payload = try #require(JSONSerialization
                .jsonObject(with: JSONEncoder().encode(catalog)) as? [String: Any])
            let agent = try #require((payload["agents"] as? [[String: Any]])?.first)
            #expect(agent["avatar"] as? String == expected)
            #expect(catalog.agents.first?.avatarText == "RS")
        }
    }

    @Test func `agent image routes stay on the connected Gateway and retain their revision`() throws {
        let context = try OpenClawChatSourceContext(
            gatewayURL: #require(URL(string: "https://gateway.test/socket")), basePath: "/control")
        #expect(OpenClawSidebarAgentAvatarSource.resourceURL(
            "/control/avatar/research?v=2#ignored", context: context)?.absoluteString ==
            "https://gateway.test/control/avatar/research?v=2")
        for source in [
            "https://other.test/control/avatar/research", "//other.test/control/avatar/research",
            "/control/avatar/research/extra", "/control/avatar/", "/control/avatar/%2e%2e",
            "/control/avatar/%zz", "/control/api/secrets", "/avatar/research", "/control\\avatar/research",
        ] {
            #expect(OpenClawSidebarAgentAvatarSource.resourceURL(source, context: context) == nil)
        }
        #expect(OpenClawSidebarAgentAvatarSource.inlineData("data:image/png;base64,YQ==") == Data([97]))
        #expect(OpenClawSidebarAgentAvatarSource.inlineData("data:image/svg+xml,%3Csvg%2F%3E") == Data("<svg/>".utf8))
        #expect(OpenClawSidebarAgentAvatarSource.inlineData("data:image/png,%89PNG") == Data([137, 80, 78, 71]))
        #expect(OpenClawSidebarAgentAvatarSource.inlineData("data:text/plain;base64,YQ==") == nil)
        #expect(OpenClawSidebarAgentAvatarSource.inlineData("data:image/png;base64,invalid") == nil)
        #expect(OpenClawSidebarAgentAvatarSource.inlineData(
            "data:image/png;base64," + Data(repeating: 0, count: 2 * 1024 * 1024 + 1).base64EncodedString()) == nil)
    }

    @Test func `identity refreshes replace prior names and isolate failed or mismatched identities`() async throws {
        for name in ["First identity", "Updated identity"] {
            var catalog: OpenClawChatAgentsListResponse?
            try await OpenClawChatAgentsListResponse.load(
                request: { request in
                    if request.method == "agents.list" {
                        return Data(
                            #"""
                            {"defaultId":"main","mainKey":"main","scope":"per-sender",
                             "agents":[{"id":"main"},{"id":"offline","name":"Configured"},{"id":"mismatch"}]}
                            """#
                                .utf8)
                    }
                    let id = try #require(request.params["agentId"]?.value as? String)
                    if id == "offline" { throw URLError(.notConnectedToInternet) }
                    return try JSONEncoder().encode(AgentIdentityResult(
                        agentid: id == "mismatch" ? "another-agent" : id,
                        name: name,
                        avatar: "AB",
                        emoji: "🦞"))
                },
                isCurrent: { true },
                onUpdate: { catalog = $0 })
            #expect(catalog?.agents.map(\.displayName) == [name, "Configured", "mismatch"])
            #expect(catalog?.agents.map(\.avatarText) == ["🦞", "C", "M"])
        }
    }

    @Test func `a retired connection cannot publish a partially hydrated catalog`() async {
        await #expect(throws: CancellationError.self) {
            try await OpenClawChatAgentsListResponse.load(
                request: { request in
                    if request.method == "agents.list" {
                        return Data(
                            #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main"}]}"#
                                .utf8)
                    }
                    throw CancellationError()
                },
                isCurrent: { false },
                onUpdate: { _ in Issue.record("Retired roster published") })
        }
    }

    @Test func `scoped legacy session rows retain their owner without rewriting global keys`() throws {
        let data = Data(#"{"sessions":[{"key":"global"},{"key":"agent:research:global"}]}"#.utf8)
        let result = try OpenClawChatGatewayPayloadCodec.decodeSessionsList(data, agentID: "main")
        #expect(result.sessions.map(\.key) == ["global", "agent:research:global"])
        #expect(result.sessions.map(\.agentId) == ["main", "research"])
    }

    @Test(arguments: ["[]", #"[{"id":"system","kind":"system"}]"#])
    func `empty selectable rosters preserve the server default`(agents: String) throws {
        let data = Data("""
        {"defaultId":"system","mainKey":"main","scope":"per-sender","agents":\(agents)}
        """.utf8)

        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data) ==
            OpenClawChatAgentsListResponse(
                defaultId: "system",
                agents: [],
                sessionRoutingContract: "per-sender|main|system"))
    }

    @Test func `agent navigation retains identity and configured main routing`() throws {
        let data = Data(
            #"""
            {"defaultId":"ops","mainKey":"inbox","scope":"global",
             "agents":[{"id":"ops","name":"Operations","identity":{"emoji":"🛠️"},"workspaceGit":true}]}
            """#
                .utf8)

        let catalog = try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data)

        #expect(catalog.sessionRoutingContract == "global|inbox|ops")
        #expect(catalog.agents == [
            OpenClawChatAgentChoice(id: "ops", name: "Operations", emoji: "🛠️", workspaceGit: true),
        ])
    }

    @Test(arguments: [
        #"{"defaultId":"main","scope":"per-sender","agents":[]}"#,
        #"{"defaultId":"main","mainKey":"main","agents":[]}"#,
        #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main","kind":"unknown"}]}"#,
    ])
    func `malformed gateway rosters retain protocol decoding failures`(payload: String) {
        #expect(throws: DecodingError.self) {
            try OpenClawChatGatewayPayloadCodec.decodeAgentsList(Data(payload.utf8))
        }
    }
}
