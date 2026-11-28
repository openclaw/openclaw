import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct ChatInfoMediaTests {
    private func item(_ id: String, seq: Int?) -> ArtifactSummary {
        ArtifactSummary(id: id, type: "image", title: id, messageseq: seq, download: ["mode": AnyCodable("bytes")])
    }

    @Test func `newest artifacts come first and undated ones last`() {
        let items = [self.item("a", seq: 2), self.item("b", seq: nil), self.item("c", seq: 9), self.item("d", seq: 2)]
        #expect(ChatInfoVisit.newestFirst(items).map(\.id) == ["c", "d", "a", "b"])
    }

    @Test func `a failed re-read keeps items already on screen`() {
        let shown = ChatInfoRead<[Int]>.loaded([1])
        guard case .loaded([1]) = shown.replaced(by: .failed) else { Issue.record("dropped loaded items")
            return
        }
        guard case .loaded([2]) = shown.replaced(by: .loaded([2])) else { Issue.record("kept stale items")
            return
        }
        guard case .failed = ChatInfoRead<[Int]>.loading.replaced(by: .failed) else {
            Issue.record("hid a first failure")
            return
        }
    }
}
