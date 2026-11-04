import OpenClawKit
import SafariServices
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct CloudflareAccessBrowserDataStoreTests {
    @Test(.timeLimit(.minutes(1)))
    func `account switch with injected website reset preserves a saved native Keychain grant`() async throws {
        // The hosted app shares Safari storage with existing sessions; never clear it in routine tests.
        // This covers native grant preservation, not Apple's storage separation or IdP account selection.
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
        var resets = 0
        let website = AsyncStream<Void>.makeStream()
        let presenter = CloudflareAccessBrowserPresenter(
            present: { _ in
                #expect(resets == 1)
                website.continuation.yield(())
                website.continuation.finish()
            },
            dismiss: { _ in },
            presentPrompt: { prompts.append($0) },
            dismissPrompt: { _ in },
            clearWebsiteData: { resets += 1 })
        let nextOrigin = try CloudflareAccessOrigin(
            #require(URL(string: "https://next-\(identifier).example.test")))
        let id = UUID()
        let preparing = Task { try await presenter.prepare(nextOrigin, intentID: id) {} }
        defer { preparing.cancel() }
        try await waitForIngress { prompts.count == 1 }
        presenter.continuePreparation(from: prompts[0], clearWebsiteData: true)
        var websiteEvents = website.stream.makeAsyncIterator()
        let opened = await websiteEvents.next()
        try #require(opened != nil)

        #expect(resets == 1)
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
