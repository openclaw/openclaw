import Testing
@testable import OpenClaw

@MainActor
struct AuthenticatedControlUIDocumentTests {
    @Test func `hub HTTP failures expose recovery instead of a blank document`() async throws {
        let server = try SettingsHubHTTPFixture(body: "Unavailable", status: 503, contentType: "text/plain")
        defer { server.stop() }
        let state = AuthenticatedControlUIDocumentState()
        let fixture = try await DashboardResponseFixture(
            url: server.start(), documentState: state, usesEmbedCompatibility: false)
        defer { fixture.stop() }

        _ = try await fixture.load()

        #expect(state.phase == .failed)
        #expect(server.requestCount == 1)
    }

    @Test func `explicit reload recovers a terminated hub on the same web view`() async throws {
        let server = try SettingsHubHTTPFixture(body: "<!doctype html><html><body>Desktop</body></html>")
        defer { server.stop() }
        let state = AuthenticatedControlUIDocumentState()
        let fixture = try await DashboardResponseFixture(
            url: server.start(), documentState: state, usesEmbedCompatibility: false)
        defer { fixture.stop() }
        _ = try await fixture.load()
        #expect(state.phase == .ready)

        // Inject only the WebKit process-termination callback, then use the production reload path.
        fixture.terminateDocument()
        #expect(state.phase == .failed)
        #expect(server.requestCount == 1)
        await fixture.reload()

        #expect(state.phase == .ready)
        #expect(server.requestCount == 2)
    }
}
