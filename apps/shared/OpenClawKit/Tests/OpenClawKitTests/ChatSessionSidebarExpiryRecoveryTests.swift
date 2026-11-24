import Foundation
import struct OpenClawKit.GatewayResponseError
import Testing
@testable import OpenClawChatUI

extension ChatSessionSidebarQueryTests {
    @Test func `expired roster recovers missing membership after a transient list failure`() async throws {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        _ = await self.load(owner, transport, self.page(
            [self.row("b"), self.row("c"), self.row("d")],
            paging: #""ts":1000000,"activityExpiresAt":1000099,"hasMore":true,"nextOffset":3"#))
        owner.scheduleLoad(afterRosterExpiry: true)
        let wake = try #require(owner.refreshCoordinator.task)
        let unavailable = await transport.next()
        await transport.replyAutomatically(with: self.page([self.row("a"), self.row("b"), self.row("c")]))
        unavailable.reply.resume(throwing: GatewayResponseError(
            method: "sessions.list", code: "UNAVAILABLE", message: "Temporary roster failure", details: nil))
        await wake.value
        await owner.refreshCoordinator.task?.value
        #expect(owner.rows.compactMap(\.sessionId) == ["a", "b", "c"])
        #expect(owner.errorText == nil)
        let requests = await transport.requests
        #expect(requests.map(\.method) == ["sessions.list", "sessions.list", "sessions.list"])
        #expect(requests.allSatisfy { $0.params == unavailable.request.params })
    }

    @Test(arguments: [("UNAVAILABLE", true, 2), ("FORBIDDEN", true, 1), ("UNAVAILABLE", false, 1)])
    func `only an unavailable expiry read retries once and leaves manual retry usable`(
        code: String, afterRosterExpiry: Bool, attempts: Int) async throws
    {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        await transport.replyUsing { _ in
            throw GatewayResponseError(method: "sessions.list", code: code, message: "Roster unavailable", details: nil)
        }
        owner.scheduleLoad(afterRosterExpiry: afterRosterExpiry)
        let initial = try #require(owner.refreshCoordinator.task)
        await initial.value
        let last = try #require(owner.refreshCoordinator.task)
        await last.value
        #expect(await transport.requests.count == attempts)
        #expect(owner.refreshCoordinator.task == last) // No third read is queued after a second refusal.
        #expect(owner.errorText?.contains(code) == true)
        #expect(!owner.isLoading)
        let fresh = self.page([self.row("restored")])
        await transport.replyUsing { _ in fresh }
        await owner.retry()
        #expect(owner.rows.compactMap(\.sessionId) == ["restored"])
        #expect(owner.errorText == nil)
        #expect(await transport.requests.count == attempts + 1)
    }

    @Test func `a late expiry failure cannot schedule a read on a replacement scope`() async throws {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        owner.scheduleLoad(afterRosterExpiry: true)
        let wake = try #require(owner.refreshCoordinator.task)
        let old = await transport.next()
        owner.invalidate(clear: true)
        owner.setQuery(.init(agentID: "another"))
        old.reply.resume(throwing: GatewayResponseError(
            method: "sessions.list", code: "UNAVAILABLE", message: "Old route", details: nil))
        await wake.value
        #expect(owner.errorText == nil)
        #expect(owner.refreshCoordinator.task == nil)
        #expect(await transport.requests.count == 1)
    }
}
