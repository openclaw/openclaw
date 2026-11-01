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
        let presenter = CloudflareAccessBrowserPresenter(
            present: { browsers.append($0) },
            dismiss: { _ in },
            presentPrompt: { prompts.append($0) },
            dismissPrompt: { _ in })
        let origin = try CloudflareAccessOrigin(#require(URL(string: "https://gateway.example.test")))
        let id = UUID()
        let preparing = Task {
            try await presenter.prepare(origin, intentID: id) { cancellations += 1 }
            prepared = true
        }
        defer { preparing.cancel() }
        try await waitForIngress { prompts.count == 1 }
        #expect(browsers.isEmpty)
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
