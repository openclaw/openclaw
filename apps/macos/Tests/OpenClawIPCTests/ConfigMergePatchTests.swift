import Foundation
import Testing
@testable import OpenClaw

struct ConfigMergePatchTests {
    @Test func `unrelated edits exclude unchanged roster and redacted credentials`() {
        let baseline: [String: Any] = [
            "agents": ["entries": ["zmain": [:], "alpha": [:]]],
            "gateway": ["mode": "local", "auth": ["token": "__OPENCLAW_REDACTED__"]],
            "browser": ["enabled": true],
        ]
        var edited = baseline
        edited["browser"] = ["enabled": false]
        let patch = ConfigMergePatch.between(baseline, and: edited)
        #expect(Set(patch.root.keys) == ["browser"])
        #expect((patch.root["browser"] as? [String: Any])?["enabled"] as? Bool == false)
        #expect(patch.replacePaths.isEmpty)
    }

    @Test func `array shrink and subtree deletion carry exact replacement intent`() {
        let baseline: [String: Any] = [
            "bindings": [["id": "first"], ["id": "second"]],
            "mcp": ["servers": ["docs": ["args": ["one", "two"]]]],
        ]
        let edited: [String: Any] = ["bindings": [["id": "first"]], "mcp": ["servers": [:]]]
        let patch = ConfigMergePatch.between(baseline, and: edited)
        #expect(patch.replacePaths == ["bindings", "mcp.servers.docs.args"])
        #expect((patch.root["bindings"] as? [[String: String]])?.map { $0["id"] } == ["first"])
        let mcp = patch.root["mcp"] as? [String: Any]
        let servers = mcp?["servers"] as? [String: Any]
        #expect(servers?["docs"] is NSNull)
    }

    @Test func `reordered ID arrays use replacement instead of keyed upserts`() {
        let baseline: [String: Any] = ["bindings": [["id": "first"], ["id": "second"]]]
        let edited: [String: Any] = ["bindings": [["id": "second"], ["id": "first"]]]
        let patch = ConfigMergePatch.between(baseline, and: edited)
        #expect(patch.replacePaths == ["bindings"])
        #expect((patch.root["bindings"] as? [[String: String]])?.map { $0["id"] } == ["second", "first"])
    }

    @Test func `removed auth fields use merge patch deletion without echoing unchanged fields`() {
        let baseline: [String: Any] = [
            "gateway": ["mode": "local", "auth": ["mode": "password", "password": "__OPENCLAW_REDACTED__"]],
        ]
        let edited: [String: Any] = ["gateway": ["mode": "local", "auth": ["mode": "none"]]]
        let patch = ConfigMergePatch.between(baseline, and: edited)
        let gateway = patch.root["gateway"] as? [String: Any]
        let auth = gateway?["auth"] as? [String: Any]
        #expect(gateway?["mode"] == nil)
        #expect(auth?["password"] is NSNull)
        #expect(auth?["mode"] as? String == "none")
    }
}
