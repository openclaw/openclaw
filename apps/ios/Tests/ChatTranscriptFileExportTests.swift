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
            model.retainedActiveSession = nil
            model.sessions = rows
            let url = try ChatInfoPage.writeTranscript(for: model, in: directory)
            #expect(url.lastPathComponent == filename)
            #expect(try Data(contentsOf: url) == Data((heading + body).utf8))
        }
    }

    @Test func `names the file after a chat the roster leaves out`() throws {
        let key = "agent:main:field-notes"
        let model = OpenClawChatViewModel(
            sessionKey: key,
            transport: IOSGatewayChatTransport(gateway: GatewayNodeSession()))
        defer { model.detachTransport() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString,
            isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        // The capped roster holds newer chats only; the chat's own history row is kept on the side.
        model.sessions = [OpenClawChatSessionEntry(key: "agent:main:newer", displayName: "Newer chat")]
        model.retainedActiveSession = OpenClawChatSessionEntry(key: key, displayName: "Field recording plan")

        let url = try ChatInfoPage.writeTranscript(for: model, in: directory)
        #expect(url.lastPathComponent == "Field recording plan.md")
        #expect(try String(contentsOf: url, encoding: .utf8).hasPrefix("# Field recording plan"))
    }
}
