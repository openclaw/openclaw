import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
struct ChatTranscriptFileExportTests {
    @Test func `writes the selected session title and transcript to the share file`() throws {
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: IOSGatewayChatTransport(gateway: GatewayNodeSession()))
        defer { model.detachTransport() }
        model.messages = [.init(role: "user", content: [.init(type: "text", text: "Keep this line.")], timestamp: 0)]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString,
            isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let canonical = OpenClawChatSessionEntry(key: "agent:main:main", displayName: "A")
        let exact = OpenClawChatSessionEntry(key: "main", displayName: "Review / Friday")
        let unrelated = OpenClawChatSessionEntry(key: "agent:other:other", displayName: "Unrelated")
        let body = "\n\n### User — 1970-01-01T00:00:00Z\n\nKeep this line.\n"
        for (rows, filename, heading) in [
            ([canonical], "A.md", "# A"),
            ([canonical, exact], "Review-Friday.md", "# Review / Friday"),
            ([unrelated], "main.md", "# main"),
        ] {
            model.sessions = rows
            let url = try ChatProTab.writeTranscript(for: model, in: directory)
            #expect(url.lastPathComponent == filename)
            #expect(try Data(contentsOf: url) == Data((heading + body).utf8))
        }
    }
}
