import Foundation
import OpenClawKit
import Testing

struct GatewayUserPreferencesTests {
    @Test func `mixed shortcuts retain valid pins and compare the raw snapshot`() throws {
        let data = Data(#"{"status":"ok","entries":{"ui.railShortcuts":["session:root",7,"route:chat"]}}"#.utf8)
        #expect(try GatewayUserPreferences.decodeRailShortcuts(data) == ["session:root", "route:chat"])
        let params = try #require(try GatewayUserPreferences.personalPinWriteParams(data, pinned: true, key: "other"))
        let json = try #require(JSONSerialization.jsonObject(with: Data(params.utf8)) as? [String: Any])
        let expected = try #require((json["expectedEntries"] as? [String: Any])?["ui.railShortcuts"] as? [Any])
        #expect(expected.count == 3)
        #expect(expected[1] as? Int == 7)
        #expect(GatewayUserPreferences.settingPersonalPin(true, key: "root", in: ["session:root", "route:chat"]) == [
            "session:root",
            "route:chat",
        ])
        #expect(try GatewayUserPreferences.personalPinWriteParams(data, pinned: true, key: " ") == nil)
    }

    @Test func `personal pin writes compare the server snapshot and never write without identity`() throws {
        let absent = Data(#"{"status":"ok","entries":{}}"#.utf8)
        let params = try #require(try GatewayUserPreferences.personalPinWriteParams(absent, pinned: true, key: "root"))
        let json = try #require(JSONSerialization.jsonObject(with: Data(params.utf8)) as? [String: Any])
        #expect((json["entries"] as? [String: [String]])?["ui.railShortcuts"] == ["session:root"])
        #expect((json["expectedEntries"] as? [String: Any])?["ui.railShortcuts"] is NSNull)
        let empty = Data(#"{"status":"ok","entries":{"ui.railShortcuts":[]}}"#.utf8)
        let emptyParams = try #require(try GatewayUserPreferences.personalPinWriteParams(
            empty,
            pinned: false,
            key: "root"))
        let emptyJSON = try #require(JSONSerialization.jsonObject(with: Data(emptyParams.utf8)) as? [String: Any])
        #expect((emptyJSON["expectedEntries"] as? [String: [String]])?["ui.railShortcuts"] == [])
        #expect(try GatewayUserPreferences.personalPinWriteParams(
            Data(#"{"status":"no_durable_identity"}"#.utf8), pinned: true, key: "root") == nil)
    }

    @Test func `personal pins distinguish empty from unavailable preferences`() throws {
        #expect(try GatewayUserPreferences.decodeRailShortcuts(
            Data(#"{"status":"ok","entries":{"ui.railShortcuts":[]}}"#.utf8)) == [])
        #expect(try GatewayUserPreferences.decodeRailShortcuts(
            Data(#"{"status":"ok","entries":{}}"#.utf8)) == [])
        #expect(try GatewayUserPreferences.decodeRailShortcuts(
            Data(#"{"status":"no_durable_identity"}"#.utf8)) == nil)
        #expect(try GatewayUserPreferences.decodeRailShortcuts(
            Data(#"{"status":"ok","entries":{"ui.railShortcuts":false}}"#.utf8)) == nil)
    }

    @Test func `pin intent rebases without replacing other personal shortcuts`() {
        let remote = ["route:chat", "session:other", "session-rail:rail", "plugin:example/view"]
        let pinned = GatewayUserPreferences.settingPersonalPin(true, key: "root", in: remote)
        #expect(pinned == remote + ["session:root"])
        #expect(GatewayUserPreferences.personalSessionPinKeys(pinned) == ["other", "root"])
        #expect(GatewayUserPreferences.settingPersonalPin(false, key: "root", in: pinned) == remote)
        #expect(GatewayUserPreferences.settingPersonalPin(true, key: "root", in: pinned) == pinned)
    }

    @Test func `normalizes bare and prefixed hex`() {
        #expect(GatewayUserPreferences.normalizedAccentHex("#A1B2C3") == "#a1b2c3")
        #expect(GatewayUserPreferences.normalizedAccentHex("a1b2c3") == "#a1b2c3")
        #expect(GatewayUserPreferences.normalizedAccentHex("  #ff0000  ") == "#ff0000")
    }

    @Test(arguments: [
        nil,
        "",
        "#fff",
        "#ff0000aa",
        "red",
        "#12345g",
        "+abcde1",
        "+12345",
        "-12345",
        "#ＦＦＦＦＦＦ"
    ] as [String?])
    func `rejects invalid hex`(value: String?) {
        #expect(GatewayUserPreferences.normalizedAccentHex(value) == nil)
    }

    @Test func `gateway preference precedes operator color and theme restores the default`() {
        #expect(GatewayUserPreferences.gatewayAccentHex(
            preference: "#A1B2C3", seamColor: "#0055dd") == "#a1b2c3")
        #expect(GatewayUserPreferences.gatewayAccentHex(
            preference: "theme", seamColor: "#0055dd") == nil)
        #expect(GatewayUserPreferences.gatewayAccentHex(
            preference: "invalid", seamColor: "#0055dd") == "#0055dd")
        #expect(GatewayUserPreferences.gatewayAccentHex(
            preference: nil, seamColor: "#0055dd") == "#0055dd")
    }

    @Test func `profile accent reads its entry without rejecting unrelated fields`() throws {
        let response = Data(##"{"status":"ok","entries":{"ui.accent":"#A1B2C3","ui.theme":"dark"},"extra":true}"##.utf8)

        #expect(try GatewayUserPreferences.decodeProfileAccent(response) == .color("#a1b2c3"))
    }

    @Test func `explicit profile theme suppresses the Gateway accent`() throws {
        let response = Data(#"{"status":"ok","entries":{"ui.accent":"theme"}}"#.utf8)

        #expect(try GatewayUserPreferences.decodeProfileAccent(response) == .theme)
        #expect(try GatewayUserPreferences.decodeProfileAccentHex(response) == nil)
    }

    @Test func `iOS hex projection retains its existing result`() throws {
        let response = Data(##"{"status":"ok","entries":{"ui.accent":"#A1B2C3"}}"##.utf8)

        #expect(try GatewayUserPreferences.decodeProfileAccentHex(response) == "#a1b2c3")
    }

    @Test(arguments: [
        #"{"status":"ok"}"#,
        #"{"status":"ok","entries":null}"#,
        #"{"status":"ok","entries":[]}"#,
        #"{"status":"ok","entries":{}}"#,
        #"{"status":"ok","entries":{"ui.accent":"not-a-color"}}"#,
        #"{"status":"ok","entries":{"ui.accent":42}}"#,
        #"{"status":"ok","entries":{"ui.accent":null}}"#,
    ])
    func `profile accent rejects missing or malformed entries`(payload: String) throws {
        #expect(try GatewayUserPreferences.decodeProfileAccent(Data(payload.utf8)) == .inherited)
    }

    @Test(arguments: [
        ##"{"entries":{"ui.accent":"#123456"}}"##,
        ##"{"status":"no_durable_identity","entries":{"ui.accent":"#123456"}}"##,
        ##"{"status":"OK","entries":{"ui.accent":"#123456"}}"##,
        ##"[{"status":"ok","entries":{"ui.accent":"#123456"}}]"##,
    ])
    func `only an ok profile response can supply an accent`(payload: String) throws {
        #expect(try GatewayUserPreferences.decodeProfileAccent(Data(payload.utf8)) == .inherited)
    }

    @Test(arguments: ["", "{"])
    func `malformed JSON preserves the callers error path`(payload: String) {
        #expect(throws: Error.self) {
            try GatewayUserPreferences.decodeProfileAccent(Data(payload.utf8))
        }
    }
}
