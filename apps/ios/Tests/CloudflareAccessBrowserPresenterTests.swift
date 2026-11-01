import SafariServices
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct CloudflareAccessBrowserPresenterTests {
    @Test func `website Done requires explicit confirmation before transfer`() async throws {
        var prompts: [UIAlertController] = []
        var browsers: [SFSafariViewController] = []
        var cancellations = 0
        var prepared = false
        var clears = 0
        let presenter = CloudflareAccessBrowserPresenter(
            present: { browsers.append($0) },
            dismiss: { _ in },
            presentPrompt: { prompts.append($0) },
            dismissPrompt: { _ in },
            clearWebsiteData: { clears += 1 })
        let origin = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test")))
        let id = UUID()
        let preparing = Task {
            try await presenter.prepare(origin, intentID: id) { cancellations += 1 }
            prepared = true
        }
        defer { preparing.cancel() }
        try await waitForIngress { prompts.count == 1 }
        #expect(browsers.isEmpty)
        #expect(prompts[0].actions.contains { $0.title == "Use another account" })
        presenter.continuePreparation(from: prompts[0])
        try await waitForIngress { browsers.count == 1 }
        #expect(browsers[0].dismissButtonStyle == .done)
        presenter.safariViewControllerDidFinish(browsers[0])
        try await waitForIngress { prompts.count == 2 }
        #expect(!prepared)
        #expect(cancellations == 0)
        // A callback from the first prompt cannot accept the second prompt.
        presenter.continuePreparation(from: prompts[0])
        #expect(!prepared)
        presenter.continuePreparation(from: prompts[1])
        try await preparing.value
        #expect(prepared)
        let transfer = try #require(URL(string: "https://gateway.example.test/cdn-cgi/access/cli?token=fixture"))
        try await presenter.open(transfer, intentID: id) { cancellations += 1 }
        #expect(browsers.count == 2)
        #expect(browsers[1].dismissButtonStyle == .cancel)
        presenter.safariViewControllerDidFinish(browsers[0])
        #expect(cancellations == 0)
        presenter.safariViewControllerDidFinish(browsers[1])
        await presenter.dismiss(intentID: id)
        #expect(cancellations == 1)
        #expect(clears == 0)
    }

    @Test func `another account clears app browser data once before website and preserves transfer login`() async throws {
        var prompts: [UIAlertController] = []
        var browsers: [SFSafariViewController] = []
        var events: [String] = []
        let presenter = CloudflareAccessBrowserPresenter(
            present: {
                browsers.append($0)
                events.append("browser")
            },
            dismiss: { _ in },
            presentPrompt: { prompts.append($0) },
            dismissPrompt: { _ in events.append("dismiss prompt") },
            clearWebsiteData: { events.append("clear") })
        let origin = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test")))
        let id = UUID()
        let preparing = Task { try await presenter.prepare(origin, intentID: id) {} }
        defer { preparing.cancel() }
        try await waitForIngress { prompts.count == 1 }
        #expect(events.isEmpty)
        presenter.continuePreparation(from: prompts[0], clearWebsiteData: true)
        try await waitForIngress { browsers.count == 1 }
        #expect(events == ["dismiss prompt", "clear", "browser"])
        presenter.safariViewControllerDidFinish(browsers[0])
        try await waitForIngress { prompts.count == 2 }
        #expect(!prompts[1].actions.contains { $0.title == "Use another account" })
        // A stale action cannot reset the account selected by the live website step.
        presenter.continuePreparation(from: prompts[0], clearWebsiteData: true)
        presenter.continuePreparation(from: prompts[1])
        try await preparing.value
        try await presenter.open(origin.url, intentID: id) {}
        #expect(browsers.count == 2)
        #expect(events.filter { $0 == "clear" }.count == 1)
        await presenter.dismiss(intentID: id)
    }

    @Test(arguments: [false, true])
    func `cancellation or replacement waits for reset and never opens stale website`(replace: Bool) async throws {
        var prompts: [UIAlertController] = []
        var browsers: [SFSafariViewController] = []
        var reset: CheckedContinuation<Void, Never>?
        var resetFinished = false
        var replacementStarted = false
        let presenter = CloudflareAccessBrowserPresenter(
            present: {
                #expect(resetFinished)
                browsers.append($0)
            },
            dismiss: { _ in },
            presentPrompt: { prompts.append($0) },
            dismissPrompt: { _ in },
            clearWebsiteData: {
                await withCheckedContinuation { reset = $0 }
                resetFinished = true
            })
        let origin = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test")))
        let oldID = UUID()
        let preparing = Task { try await presenter.prepare(origin, intentID: oldID) {} }
        defer { preparing.cancel() }
        try await waitForIngress { prompts.count == 1 }
        presenter.continuePreparation(from: prompts[0], clearWebsiteData: true)
        try await waitForIngress { reset != nil }
        let replacementID = UUID()
        let replacement: Task<Void, Error>?
        if replace {
            replacement = Task {
                replacementStarted = true
                try await presenter.open(origin.url, intentID: replacementID) {}
            }
            try await waitForIngress { replacementStarted }
        } else {
            replacement = nil
            preparing.cancel()
        }
        #expect(browsers.isEmpty)
        let pendingReset = try #require(reset)
        reset = nil
        pendingReset.resume()
        await #expect(throws: CancellationError.self) { try await preparing.value }
        try await replacement?.value
        #expect(browsers.count == (replace ? 1 : 0))
        // Neither replaying the old action nor its eventual dismissal can affect the new intent.
        presenter.continuePreparation(from: prompts[0], clearWebsiteData: true)
        await presenter.dismiss(intentID: oldID)
        #expect(browsers.count == (replace ? 1 : 0))
        await presenter.dismiss(intentID: replacementID)
    }

    @Test(arguments: [false, true])
    func `cancellation or replacement during preparation cannot continue`(replace: Bool) async throws {
        var prompts: [UIAlertController] = []
        var browsers: [SFSafariViewController] = []
        let presenter = CloudflareAccessBrowserPresenter(
            present: { browsers.append($0) },
            dismiss: { _ in },
            presentPrompt: { prompts.append($0) },
            dismissPrompt: { _ in })
        let origin = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test")))
        let oldID = UUID()
        let preparing = Task { try await presenter.prepare(origin, intentID: oldID) {} }
        defer { preparing.cancel() }
        try await waitForIngress { prompts.count == 1 }
        let replacementID = UUID()
        if replace {
            try await presenter.open(origin.url, intentID: replacementID) {}
        } else {
            preparing.cancel()
        }
        await #expect(throws: CancellationError.self) { try await preparing.value }
        presenter.continuePreparation(from: prompts[0])
        #expect(browsers.count == (replace ? 1 : 0))
        await presenter.dismiss(intentID: replacementID)
    }

    @Test func `website swipe cancels instead of advancing to confirmation`() async throws {
        var prompts: [UIAlertController] = []
        var browsers: [SFSafariViewController] = []
        var cancellations = 0
        let presenter = CloudflareAccessBrowserPresenter(
            present: { browsers.append($0) },
            dismiss: { _ in },
            presentPrompt: { prompts.append($0) },
            dismissPrompt: { _ in })
        let origin = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test")))
        let preparing = Task { try await presenter.prepare(origin, intentID: UUID()) { cancellations += 1 } }
        defer { preparing.cancel() }
        try await waitForIngress { prompts.count == 1 }
        presenter.continuePreparation(from: prompts[0])
        try await waitForIngress { browsers.count == 1 }
        presenter.presentationControllerDidDismiss(UIPresentationController(
            presentedViewController: browsers[0], presenting: nil))
        await #expect(throws: CancellationError.self) { try await preparing.value }
        #expect(cancellations == 1)
        #expect(prompts.count == 1)
    }
}
