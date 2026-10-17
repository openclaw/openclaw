import OpenClawKit
import SafariServices
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct CloudflareAccessBrowserDataStoreTests {
    @Test(.timeLimit(.minutes(1)))
    func `real Safari website reset preserves a saved native Keychain grant`() async throws {
        // Exercise Apple's real clearing API without authenticating to any external website.
        // This proves storage separation, not that a third-party IdP presents an account picker.
        let seed = try CloudflareAccessTestTokens().session()
        let token = try #require(seed.authorizationHeader(for: seed.origin.url))
        let identifier = UUID().uuidString.lowercased()
        let savedOrigin = try CloudflareAccessOrigin(
            #require(URL(string: "https://saved-\(identifier).example.test")))
        let savedApplication = CloudflareAccessApplication(
            origin: savedOrigin, issuer: seed.issuer, audience: seed.audience)
        let savedSession = CloudflareAccessSession(
            application: savedApplication, subject: seed.subject, token: token, expiresAt: seed.expiresAt)
        let service = "\(Bundle.main.bundleIdentifier ?? "ai.openclaw.ios").cloudflare-access"
        let account = savedOrigin.url.absoluteString
        let absent = GenericPasswordKeychainStore.loadString(service: service, account: account) == nil
        try #require(absent)
        defer {
            // Clean only this test's unique account, never the shared Keychain service.
            #expect(GenericPasswordKeychainStore.delete(service: service, account: account))
        }

        var retired: [CloudflareAccessOrigin] = []
        let writer = CloudflareAccessSessionStore(
            authenticate: { _, _ in savedSession },
            retireTransports: { retired.append($0) })
        let original = try await writer.signIn(application: savedApplication, openBrowser: { _ in }).value
        let savedBytes = try #require(GenericPasswordKeychainStore.loadString(service: service, account: account))
        retired.removeAll()

        var prompts: [UIAlertController] = []
        let website = AsyncStream<Void>.makeStream()
        // Deliberately omit clearWebsiteData: this invokes the supported default Apple API.
        let presenter = CloudflareAccessBrowserPresenter(
            present: { _ in
                website.continuation.yield(())
                website.continuation.finish()
            },
            dismiss: { _ in },
            presentPrompt: { prompts.append($0) },
            dismissPrompt: { _ in })
        let nextOrigin = try CloudflareAccessOrigin(
            #require(URL(string: "https://next-\(identifier).example.test")))
        let id = UUID()
        let preparing = Task { try await presenter.prepare(nextOrigin, intentID: id) {} }
        defer { preparing.cancel() }
        try await waitForIngress { prompts.count == 1 }
        presenter.continuePreparation(from: prompts[0], clearWebsiteData: true)
        // Wait for the actual system completion, not the short mock-ingress polling deadline.
        var websiteEvents = website.stream.makeAsyncIterator()
        let opened = await websiteEvents.next()
        try #require(opened != nil)

        // Presentation can occur only after Apple's awaited clearing callback finishes.
        let bytesAfterReset = GenericPasswordKeychainStore.loadString(service: service, account: account)
        #expect(bytesAfterReset == savedBytes)
        #expect(writer.snapshot(for: savedOrigin)?.revision == original.revision)
        #expect(retired.isEmpty)
        let coldStore = CloudflareAccessSessionStore(
            authenticate: { _, _ in throw CloudflareAccessError.loginFailed },
            retireTransports: { retired.append($0) })
        let restored = try #require(coldStore.snapshot(for: savedOrigin))
        #expect(restored.session.subject == seed.subject)
        #expect(restored.session.authorizationHeader(for: savedOrigin.url) == token)
        #expect(retired.isEmpty)

        preparing.cancel()
        _ = await preparing.result
        await presenter.dismiss(intentID: id)
    }
}
