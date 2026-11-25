import Foundation
import Testing
@testable import OpenClawNativeState

struct ClientCredentialProtocolTests {
    @Test func `actual TypeScript owner requests and results agree with Swift`() throws {
        let url = try #require(Bundle.module.url(
            forResource: "operations",
            withExtension: "json",
            subdirectory: "Fixtures/ClientCredentials"))
        let seed = Data((0..<32).map { UInt8($0) })
        let pkcs8 = Data([
            0x30, 0x2E, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
            0x03, 0x2B, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
        ]) + seed
        let label = "PRIVATE KEY"
        let fence = String(repeating: "-", count: 5)
        let privateKey = "\(fence)BEGIN \(label)\(fence)\n"
            + "\(pkcs8.base64EncodedString())\n\(fence)END \(label)\(fence)\n"
        let encodedKey = try #require(String(data: JSONEncoder().encode(privateKey), encoding: .utf8))
        let source = try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "\"synthetic:ed25519-seed-0-through-31\"", with: encodedKey)
        let fixture = try #require(JSONSerialization.jsonObject(with: Data(source.utf8)) as? [String: Any])
        let cases = try #require(fixture["cases"] as? [[String: Any]])
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
            .appendingPathComponent("credential-wire-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let owner = try OpenClawClientCredentialStore(rootURL: root)
        defer { owner.close() }
        for item in cases {
            let operation = try JSONDecoder().decode(
                ClientCredentialOperation.self,
                from: JSONSerialization
                    .data(withJSONObject: #require(item["operation"])))
            let actual = try #require(JSONSerialization.jsonObject(
                with: JSONEncoder().encode(owner.execute(operation))) as? NSDictionary)
            let expected = try #require(item["result"] as? NSDictionary)
            #expect(actual.isEqual(expected), Comment(rawValue: item["name"] as? String ?? "wire case"))
        }
    }

    @Test func `actual TypeScript receipts open local stores without reading a version zero PG anchor`() throws {
        let url = try #require(Bundle.module.url(
            forResource: "receipts",
            withExtension: "json",
            subdirectory: "Fixtures/ClientCredentials"))
        let fixture = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        for item in try #require(fixture["cases"] as? [[String: Any]]) {
            let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
                .appendingPathComponent("credential-receipt-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: root) }
            let source = root.appendingPathComponent("state/openclaw.sqlite")
            do {
                let anchor = try OpenClawNativeStateSQLite(databaseURL: source)
                try anchor.execute("""
                CREATE TABLE openclaw_engine_anchor (engine TEXT);
                INSERT INTO openclaw_engine_anchor VALUES ('postgres')
                """)
            }
            let before = try Data(contentsOf: source)
            let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
            try owner.run(
                "INSERT INTO client_credential_migration VALUES (1,?,?,0)",
                [.text(#require(item["source_store"] as? String)), .text(#require(item["phase"] as? String))])
            var receipt = try #require(owner.readReceipt()?.receipt)
            #expect(receipt.source?.destinationVersion == nil || receipt.source?.destinationVersion == 1)
            receipt.sharedFile = try .inspect(source)
            if receipt.source?.engine == "sqlite" {
                receipt.source?.identity = try ClientCredentialReceipt.SharedFile.inspect(source).path + ":123"
            }
            try owner.writeReceipt(receipt)
            owner.close()
            let activatedRoot = root.appendingPathExtension("activated")
            defer { try? FileManager.default.removeItem(at: activatedRoot) }
            try FileManager.default.moveItem(at: root, to: activatedRoot)
            let admitted = try OpenClawClientCredentialStore(rootURL: activatedRoot)
            admitted.close()
            #expect(try Data(contentsOf: activatedRoot.appendingPathComponent("state/openclaw.sqlite")) == before)
        }
    }

    @Test(arguments: [
        "valid", "whitespace", "emptyIdentity", "emptyGeneration", "shortDigest", "uppercaseDigest", "nonHexDigest",
    ])
    func `canonical receipt admission validates source metadata`(_ variant: String) throws {
        let url = try #require(Bundle.module.url(
            forResource: "receipts", withExtension: "json", subdirectory: "Fixtures/ClientCredentials"))
        let fixture = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let cases = try #require(fixture["cases"] as? [[String: Any]])
        let item = try #require(cases.first { $0["name"] as? String == "canonical-sqlite" })
        let serialized = try #require(item["source_store"] as? String)
        var receipt = try JSONDecoder().decode(ClientCredentialReceipt.self, from: Data(serialized.utf8))
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
            .appendingPathComponent("credential-source-metadata-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("state/openclaw.sqlite")
        try FileManager.default.createDirectory(
            at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        let before = Data("opaque selected database".utf8)
        try before.write(to: source)
        let binding = try ClientCredentialReceipt.SharedFile.inspect(source)
        receipt.sharedFile = binding
        receipt.source?.identity = binding.path + ":123"
        switch variant {
        case "whitespace":
            receipt.source?.identity = " "
            receipt.source?.generation = " "
        case "emptyIdentity": receipt.source?.identity = ""
        case "emptyGeneration": receipt.source?.generation = ""
        case "shortDigest": receipt.source?.sha256 = String(repeating: "a", count: 63)
        case "uppercaseDigest": receipt.source?.sha256 = String(repeating: "A", count: 64)
        case "nonHexDigest": receipt.source?.sha256 = String(repeating: "g", count: 64)
        default: break
        }
        let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
        let raw = try #require(String(data: JSONEncoder().encode(receipt), encoding: .utf8))
        try owner.run("INSERT INTO client_credential_migration VALUES (1, ?, 'complete', 0)", [.text(raw)])
        owner.close()
        if variant == "valid" || variant == "whitespace" {
            let admitted = try OpenClawClientCredentialStore(rootURL: root)
            admitted.close()
        } else {
            #expect(throws: OpenClawNativeStateError.self) {
                let admitted = try OpenClawClientCredentialStore(rootURL: root)
                admitted.close()
            }
        }
        #expect(try Data(contentsOf: source) == before)
    }

    @Test(arguments: ["./../state/openclaw.sqlite", "./state//openclaw.sqlite", "./state\\openclaw.sqlite"])
    func `unsafe relative receipt bindings are refused`(_ binding: String) throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
            .appendingPathComponent("credential-relative-refusal-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
        defer { owner.close() }
        let receipt = ClientCredentialReceipt(sharedFile: .init(path: binding, dev: "1", ino: "2"))
        let raw = try #require(String(data: JSONEncoder().encode(receipt), encoding: .utf8))
        try owner.run("INSERT INTO client_credential_migration VALUES (1, ?, 'complete', 0)", [.text(raw)])
        #expect(throws: OpenClawNativeStateError.self) { try owner.readReceipt() }
    }

    @Test func `receipt and empty result encode required explicit nulls`() throws {
        let data = try JSONEncoder().encode(ClientCredentialReceipt())
        let receipt = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(receipt["source"] is NSNull)
        #expect(receipt["sharedFile"] is NSNull)
        let result = try JSONEncoder().encode(ClientCredentialResult(kind: .identity))
        let object = try #require(JSONSerialization.jsonObject(with: result) as? [String: Any])
        #expect(object["identity"] is NSNull)
        #expect(object["kind"] as? String == "identity")
    }

    @Test func `source replacement fences local reads before selected database access`() throws {
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
            .appendingPathComponent("credential-fence-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("state/openclaw.sqlite")
        try FileManager.default.createDirectory(
            at: source.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try Data("opaque selected database".utf8).write(to: source)
        let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
        let receipt = try ClientCredentialReceipt(sharedFile: .inspect(source))
        try owner.writeReceipt(receipt)
        owner.close()
        let admitted = try OpenClawClientCredentialStore(rootURL: root)
        admitted.close()
        let replacement = root.appendingPathComponent("replacement")
        try Data("restored database".utf8).write(to: replacement)
        _ = try FileManager.default.replaceItemAt(source, withItemAt: replacement)
        #expect(throws: OpenClawNativeStateError.self) { try OpenClawClientCredentialStore(rootURL: root) }
        #expect(try Data(contentsOf: source) == Data("restored database".utf8))
    }
}
