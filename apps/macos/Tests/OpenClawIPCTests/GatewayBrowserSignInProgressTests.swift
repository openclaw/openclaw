import Foundation
import Synchronization
import Testing
@testable import OpenClaw

@MainActor
struct GatewayBrowserSignInProgressTests {
    @Test func `browser callbacks and retained buttons cannot change a revoked sign in`() throws {
        let url = try #require(URL(string: "https://gateway.example.invalid/synthetic"))
        let current = Mutex(true)
        let previous = GatewayBrowserHandoff(url: url) { current.withLock { $0 } }
        let progress = GatewayBrowserSignInProgress()
        progress.update(previous)
        #expect(progress.canOpenBrowser)
        let launchError = NSError(domain: NSOSStatusErrorDomain, code: -10814, userInfo: [
            NSLocalizedDescriptionKey: "Could not open https://gateway.example.invalid/private-transfer-key",
        ])
        progress.browserDidOpen(previous, error: launchError)
        let safeError = try #require(progress.error)
        #expect(!safeError.contains("private-transfer-key"))

        current.withLock { $0 = false }
        progress.browserDidOpen(previous, error: nil)
        #expect(progress.error == safeError)
        let replacement = GatewayBrowserHandoff(url: url) { true }
        progress.update(replacement)
        progress.openBrowser(previous)
        progress.browserDidOpen(previous, error: launchError)

        #expect(progress.handoff?.id == replacement.id)
        #expect(progress.canOpenBrowser)
        #expect(progress.error == nil)
        progress.browserDidOpen(replacement, error: launchError)
        #expect(progress.error == safeError)
        progress.browserDidOpen(previous, error: nil)
        #expect(progress.error == safeError)
        progress.browserDidOpen(replacement, error: nil)
        #expect(progress.error == nil)
        progress.update(nil)
        progress.browserDidOpen(replacement, error: launchError)
        #expect(progress.error == nil)
        #expect(!progress.canOpenBrowser)
    }
}
