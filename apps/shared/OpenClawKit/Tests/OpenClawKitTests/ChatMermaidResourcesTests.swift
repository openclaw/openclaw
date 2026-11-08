#if canImport(WebKit) && (os(iOS) || os(macOS))
import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatMermaidResourcesTests {
    @Test func `offline resources admit the bundled Pele compiler but not retired assets`() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ChatMermaidResourcesTests-\(UUID().uuidString)", isDirectory: true)
        let assets = directory.appendingPathComponent("assets", isDirectory: true)
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        for filename in ["index.html", "native.js", "frame.js"] {
            try "fixture".write(
                to: directory.appendingPathComponent(filename), atomically: true, encoding: .utf8)
        }
        let compiler = assets.appendingPathComponent("pele.min-fixture.js")
        try "fixture".write(to: compiler, atomically: true, encoding: .utf8)
        _ = try ChatMermaidSchemeHandler(directory: directory)

        try FileManager.default.removeItem(at: compiler)
        try "retired".write(
            to: assets.appendingPathComponent("mermaid.min-retired.js"),
            atomically: true, encoding: .utf8)
        #expect(throws: ChatMermaidFailure.unavailable) {
            try ChatMermaidSchemeHandler(directory: directory)
        }
    }
}
#endif
