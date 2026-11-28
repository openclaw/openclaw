import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

struct RootSidebarSessionActivityLineTests {
    private func session(status: String?) throws -> OpenClawChatSessionEntry {
        let status = status.map { ",\"status\":\"\($0)\"" } ?? ""
        let json = """
        {"key":"agent:main:work","kind":"direct","updatedAt":1,"label":"Work"\(status),
         "worktree":{"id":"w","branch":"openclaw/warm-crab-c10f9d","repoRoot":"/src/openclaw"}}
        """
        return try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(json.utf8))
    }

    @Test func `an idle row has no second line, not even its repository and branch`() throws {
        #expect(try RootSidebarSessionButton.activityLine(for: self.session(status: nil), isWorking: false) == nil)
        #expect(try RootSidebarSessionButton.activityLine(for: self.session(status: "queued"), isWorking: false) == nil)
    }

    @Test func `a working row shows its activity and never the repository line`() throws {
        #expect(try RootSidebarSessionButton.activityLine(for: self.session(status: nil), isWorking: true) == nil)
        #expect(try RootSidebarSessionButton.activityLine(for: self.session(status: "queued"), isWorking: true) ==
            "Waiting for a concurrency slot")
    }
}
