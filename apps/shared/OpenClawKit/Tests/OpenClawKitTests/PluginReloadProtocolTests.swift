import Foundation
import OpenClawProtocol
import Testing

struct PluginReloadProtocolTests {
    @Test(arguments: [1, 2])
    func `reload targets and required runtime receipt round trip`(count: Int) throws {
        let targets = (0..<count).map { index in
            PluginReloadTarget(
                pluginid: "plugin-\(index)",
                installhash: index == 0 ? nil : String(repeating: "a", count: 64),
                sourcedigests: index == 0 ? nil : ["plugin-\(index)": AnyCodable(String(repeating: "b", count: 64))])
        }
        let request = PluginsReloadParams(
            plugins: targets,
            acknowledgecapabilities: ["reviewToken": AnyCodable("reviewed-surface")])
        let encoded = try JSONEncoder().encode(request)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let wireTargets = try #require(object["plugins"] as? [[String: Any]])
        #expect(wireTargets.count == count)
        #expect(wireTargets.first?["pluginId"] as? String == "plugin-0")
        #expect(wireTargets.first?["installHash"] == nil)
        #expect(object["pluginId"] == nil)
        #expect((object["acknowledgeCapabilities"] as? [String: String])?["reviewToken"] == "reviewed-surface")
        let decoded = try JSONDecoder().decode(PluginsReloadParams.self, from: encoded)
        #expect(decoded.plugins.map(\.pluginid) == targets.map(\.pluginid))
        #expect(decoded.plugins.map(\.installhash) == targets.map(\.installhash))
        #expect(decoded.plugins.map(\.sourcedigests) == targets.map(\.sourcedigests))

        let result = PluginsReloadResult(
            ok: true,
            pluginids: targets.map(\.pluginid),
            restartrequired: false,
            runtime: PluginRuntimeApplication(operationid: "reload", generation: 7, pluginids: targets.map(\.pluginid)))
        let reply = try JSONDecoder().decode(PluginsReloadResult.self, from: JSONEncoder().encode(result))
        #expect(reply.pluginids == targets.map(\.pluginid))
        #expect(reply.restartrequired == false)
        #expect(reply.runtime.generation == 7)
        #expect(reply.runtime.operationid == "reload")
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(
                PluginsReloadResult.self,
                from: Data(#"{"ok":true,"pluginIds":["plugin-0"],"restartRequired":false}"#.utf8))
        }
    }
}
