import Foundation
import Testing
@testable import OpenClaw

struct WebChatDocumentRouteTests {
    @Test(arguments: ["", "/control", "/control/"])
    @MainActor
    func `recovery keeps the mounted private return path query and outer hash`(_ mount: String) throws {
        let base = try #require(URL(string: "https://gateway.invalid\(mount)"))
        let prefix = mount.isEmpty ? "" : "/control"
        let path = prefix + "/chat/main/~key/topic%2F%2B?draft=C%2B%2B+draft&dashboard=expanded"
        let route = try #require(URL(string: "https://gateway.invalid" + path + "#token=synthetic%2Btoken"))
        let url = try #require(WebChatRoute.recoveryDocumentURL(for: route, baseURL: base))
        let entry = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(entry.path == prefix + "/__openclaw__/session-entry")
        let search = try #require(entry.percentEncodedQuery).replacingOccurrences(of: "+", with: "%20")
        #expect(URLComponents(string: "?" + search)?.queryItems == [.init(name: "path", value: path)])
        #expect(entry.percentEncodedFragment == "token=synthetic%2Btoken")
    }

    @Test(arguments: [
        "https://foreign.invalid/control/chat/main",
        "http://gateway.invalid/control/chat/main",
        "https://gateway.invalid:444/control/chat/main",
        "https://gateway.invalid/other/chat/main",
        "https://gateway.invalid/controller/chat/main",
        "https://user:password@gateway.invalid/control/chat/main",
    ])
    @MainActor
    func `recovery rejects foreign origins mounts and URL credentials`(_ route: String) throws {
        let base = try #require(URL(string: "https://gateway.invalid/control/"))
        let url = try #require(URL(string: route))
        #expect(WebChatRoute.recoveryDocumentURL(for: url, baseURL: base) == nil)
    }

    @Test
    @MainActor
    func `recovery copies only approved return hints and leaves other dashboard documents alone`() throws {
        let base = try #require(URL(string: "https://gateway.invalid/control/"))
        let route = try #require(URL(string: "https://gateway.invalid/control/chat/main?" +
                "token=secret&password=secret&path=https%3A%2F%2Fforeign.invalid&draft=first&draft=second&" +
                "dashboard=invalid&openclaw_mount_recovery=12&__openclawSessionFacePreference=1&" +
                "__openclawComposerFocus=1&__openclawSessionKey=agent%3Amain%3Aproof"))
        let url = try #require(WebChatRoute.recoveryDocumentURL(for: route, baseURL: base))
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems == [
            .init(
                name: "path", value: "/control/chat/main?openclaw_mount_recovery=12&" +
                    "__openclawSessionFacePreference=1&__openclawComposerFocus=1&" +
                    "__openclawSessionKey=agent%3Amain%3Aproof"),
        ])
        let emptyDraft = try #require(URL(string: "https://gateway.invalid/control/chat/main?draft"))
        let emptyDraftEntry = try #require(WebChatRoute.recoveryDocumentURL(for: emptyDraft, baseURL: base))
        #expect(URLComponents(url: emptyDraftEntry, resolvingAgainstBaseURL: false)?.queryItems == [
            .init(name: "path", value: "/control/chat/main?draft"),
        ])
        for path in ["/settings", "/canvas/fixture", "/share/fixture", "/chatty/main"] {
            let document = try #require(URL(string: "https://gateway.invalid/control" + path))
            #expect(WebChatRoute.recoveryDocumentURL(for: document, baseURL: base) == document)
        }
    }

    @Test(arguments: ["", "/control", "/control/"])
    func `native documents enter the private app shell while navigation stays canonical`(_ mount: String) throws {
        let base = try #require(URL(string: "https://gateway.invalid\(mount)"))
        let url = try #require(WebChatRoute.documentURL(
            sessionKey: "agent:main:main", agentID: "main", draft: nil, baseURL: base))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let prefix = mount.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let expectedMount = prefix.isEmpty ? "" : "/" + prefix
        #expect(components.path == expectedMount + "/__openclaw__/session-entry")
        #expect(components.queryItems == [.init(name: "path", value: expectedMount + "/chat/main")])
        #expect(WebChatRoute.dashboardPath(sessionKey: "agent:main:main", agentID: "main") == "/chat/main")
    }

    @Test func `private entry preserves escaped session and draft bytes without a focus query`() throws {
        let base = try #require(URL(string: "https://gateway.invalid/control/"))
        let draft = "C++ +, &, ?, #, and\na second line 🦞"
        let url = try #require(WebChatRoute.documentURL(
            sessionKey: "agent:main:topic/+", agentID: "main", draft: draft, baseURL: base))
        let entry = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let path = try #require(entry.queryItems?.first { $0.name == "path" }?.value)
        let destination = try #require(URLComponents(string: path))
        #expect(entry.queryItems?.count == 1)
        #expect(destination.percentEncodedPath == "/control/chat/main/~key/topic%2F%2B")
        #expect(destination.queryItems == [.init(name: "draft", value: draft)])
        #expect(path.contains("C%2B%2B"))
        #expect(!path.contains("__openclawComposerFocus"))
        #expect(destination.fragment == nil)
    }

    @Test func `empty drafts do not create a return query and invalid sessions have no document`() throws {
        let base = try #require(URL(string: "https://gateway.invalid/"))
        #expect(WebChatRoute.documentURL(
            sessionKey: "agent::main", agentID: nil, draft: nil, baseURL: base) == nil)
        let url = try #require(WebChatRoute.documentURL(
            sessionKey: "agent:main:main", agentID: "main", draft: "", baseURL: base))
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems == [
            .init(name: "path", value: "/chat/main"),
        ])
    }

    @Test func `ordinary dashboard draft navigation retains its composer focus request`() throws {
        let search = try #require(WebChatRoute.dashboardSearch(draft: "Keep this draft"))
        let components = try #require(URLComponents(string: search))
        #expect(components.queryItems == [
            .init(name: "draft", value: "Keep this draft"),
            .init(name: "__openclawComposerFocus", value: "1"),
        ])
    }

    @Test func `global aliases and qualified exact sessions retain their canonical destinations`() throws {
        let base = try #require(URL(string: "https://gateway.invalid/"))
        for (key, path) in [
            ("global", "/chat/main"),
            ("agent:main:global", "/chat/main/~key/global"),
            ("agent:main:thread:child", "/chat/main/thread/child"),
        ] {
            let url = try #require(WebChatRoute.documentURL(
                sessionKey: key, agentID: "main", draft: nil, baseURL: base))
            #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems == [
                .init(name: "path", value: path),
            ])
        }
    }
}
