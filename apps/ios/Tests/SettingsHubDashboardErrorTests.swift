import Testing
@testable import OpenClaw

/// The fixture's start wait has no deadline of its own; this limit bounds a lost signal (#161616).
@Suite(.timeLimit(.minutes(10)))
@MainActor
struct SettingsHubDashboardErrorTests {
    @Test func `a plain Gateway error hands its status to the Settings host until Reload`() async throws {
        let server = try SettingsHubHTTPFixture(body: "Not Found", status: 404, contentType: "text/plain")
        defer { server.stop() }
        let fixture = try await DashboardResponseFixture(url: server.start())
        _ = try await fixture.load()

        #expect(fixture.compatibility.httpErrorStatus == 404)
        fixture.compatibility.reload()
        #expect(fixture.compatibility.httpErrorStatus == nil)
    }
}
