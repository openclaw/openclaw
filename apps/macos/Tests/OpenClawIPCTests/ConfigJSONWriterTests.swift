import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct ConfigJSONWriterTests {
    @Test func `JSON5 order survives repeated edits including nested arrays and escaped keys`() throws {
        var raw = #"""
        {
          // Deliberately not alphabetical: order selects the main agent.
          agents: { ownership: 'explicit', entries: { zmain: {}, alpha: {} } },
          'quoted\'key': [ { z: 'brace } and // text', '\u0061': true, }, ],
          browser: { enabled: true },
        }
        """#
        let decoder = JSONDecoder()
        decoder.allowsJSON5 = true
        let decoded = try decoder.decode([String: OpenClawKit.AnyCodable].self, from: Data(raw.utf8))
        var root: [String: Any] = decoded.mapValues(\.foundationValue)
        for enabled in [false, true, false] {
            root["browser"] = ["enabled": enabled]
            let data = try ConfigJSONWriter.data(withJSONObject: root, preserving: raw)
            raw = String(decoding: data, as: UTF8.self)
            let reparsed = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(NSDictionary(dictionary: root).isEqual(to: reparsed))
            for (first, second) in [("zmain", "alpha"), ("z", "a"), ("agents", "browser")] {
                let firstPosition = try #require(raw.range(of: "\"\(first)\""))
                let secondPosition = try #require(raw.range(of: "\"\(second)\""))
                #expect(firstPosition.lowerBound < secondPosition.lowerBound)
            }
        }
    }

    @Test func `removed keys stay removed and new keys append deterministically`() throws {
        let raw = #"{"z":1,"removed":2,"a":{"z":3,"a":4}}"#
        let root: [String: Any] = ["z": 1, "a": ["z": 5, "new": NSNull()], "c": true, "b": [1, "x"]]
        let data = try ConfigJSONWriter.data(withJSONObject: root, preserving: raw)
        let text = String(decoding: data, as: UTF8.self)
        #expect(!text.contains("removed"))
        let positions = try ["z", "a", "b", "c"].map { key in
            try #require(text.range(of: "\"\(key)\"")).lowerBound
        }
        #expect(positions == positions.sorted())
        let reparsed = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(NSDictionary(dictionary: root).isEqual(to: reparsed))
    }

    @Test func `unreadable source cannot silently reorder a config`() throws {
        #expect(throws: (any Error).self) {
            try ConfigJSONWriter.data(withJSONObject: ["agents": [:]], preserving: "{broken")
        }
    }

    @Test(arguments: [[1], [1, 0], [2, 1]])
    func `retained array objects keep their order after deletion movement and insertion`(_ indices: [Int]) throws {
        let source = #"{"items":[{"z":1,"a":2},{"a":3,"z":4}]}"#
        let items: [[String: Any]] = [["z": 1, "a": 2], ["a": 3, "z": 4], ["new": true]]
        let data = try ConfigJSONWriter.data(withJSONObject: ["items": indices.map { items[$0] }], preserving: source)
        let text = String(decoding: data, as: UTF8.self)
        let first = try #require(text.range(of: "\"a\": 3"))
        let second = try #require(text.range(of: "\"z\": 4"))
        #expect(first.lowerBound < second.lowerBound)
    }

    @Test func `editing array values in place preserves each object's authored order`() throws {
        let source = #"{"items":[{"z":1,"a":2},{"a":3,"z":4}]}"#
        let data = try ConfigJSONWriter.data(
            withJSONObject: ["items": [["z": 5, "a": 2], ["a": 3, "z": 6]]], preserving: source)
        let text = String(decoding: data, as: UTF8.self)
        let positions = try ["\"z\": 5", "\"a\": 2", "\"a\": 3", "\"z\": 6"].map {
            try #require(text.range(of: $0)).lowerBound
        }
        #expect(positions == positions.sorted())
    }
}
