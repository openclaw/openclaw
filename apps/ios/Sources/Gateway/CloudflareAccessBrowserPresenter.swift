import SafariServices
import UIKit

@MainActor
protocol CloudflareAccessBrowserPresenting: AnyObject {
    func open(_ url: URL, intentID: UUID, onCancel: @escaping () -> Void) async throws
    func dismiss(intentID: UUID) async
}

/// The browser only presents authentication. The encrypted transfer independently proves success.
@MainActor
final class CloudflareAccessBrowserPresenter: NSObject, @MainActor SFSafariViewControllerDelegate,
    UIAdaptivePresentationControllerDelegate, CloudflareAccessBrowserPresenting
{
    private var browser: SFSafariViewController?
    private var onCancel: (() -> Void)?
    private var intentID: UUID?
    private var requestedIntentID: UUID?
    private var presentation: Task<Void, Error>?
    private var dismissal: (id: UUID, task: Task<Void, Never>)?
    private let presentBrowser: (SFSafariViewController) async throws -> Void
    private let dismissBrowser: (SFSafariViewController) async -> Void

    init(
        present: @escaping (SFSafariViewController) async throws -> Void = CloudflareAccessBrowserPresenter.present,
        dismiss: @escaping (SFSafariViewController) async -> Void = CloudflareAccessBrowserPresenter.dismiss)
    {
        self.presentBrowser = present
        self.dismissBrowser = dismiss
        super.init()
    }

    func open(_ url: URL, intentID: UUID, onCancel: @escaping () -> Void) async throws {
        self.requestedIntentID = intentID
        if let dismissal {
            await dismissal.task.value
        }
        if let previous = self.intentID {
            await self.dismiss(intentID: previous)
        }
        try Task.checkCancellation()
        guard self.requestedIntentID == intentID else { throw CancellationError() }
        let browser = SFSafariViewController(url: url)
        browser.delegate = self
        self.browser = browser
        self.intentID = intentID
        self.onCancel = onCancel
        let presentation = Task { try await self.presentBrowser(browser) }
        self.presentation = presentation
        do {
            try await presentation.value
            try Task.checkCancellation()
            guard self.intentID == intentID, self.requestedIntentID == intentID else { throw CancellationError() }
            browser.presentationController?.delegate = self
        } catch {
            await self.dismiss(intentID: intentID)
            throw error
        }
    }

    func dismiss(intentID: UUID) async {
        if let dismissal, dismissal.id == intentID {
            await dismissal.task.value
            return
        }
        guard self.intentID == intentID, let browser else { return }
        self.onCancel = nil
        let presentation = self.presentation
        // UIKit owns the transition until its completion. Retain one shared drain
        // so cancellation and a replacement login cannot present over a dismissing browser.
        let task = Task {
            _ = await presentation?.result
            await self.dismissBrowser(browser)
        }
        dismissal = (intentID, task)
        await task.value
        guard dismissal?.id == intentID else { return }
        dismissal = nil
        if self.intentID == intentID {
            self.intentID = nil
            self.browser = nil
            self.presentation = nil
        }
        if self.requestedIntentID == intentID {
            self.requestedIntentID = nil
        }
    }

    private static func present(_ browser: SFSafariViewController) async throws {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
            var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController
        else { throw CloudflareAccessError.loginFailed }
        // Onboarding is a full-screen presentation; present above its actual controller.
        while let presented = presenter.presentedViewController {
            presenter = presented
        }
        await withCheckedContinuation { continuation in
            presenter.present(browser, animated: true) { continuation.resume() }
        }
    }

    private static func dismiss(_ browser: SFSafariViewController) async {
        guard browser.presentingViewController != nil else { return }
        await withCheckedContinuation { continuation in
            browser.dismiss(animated: true) { continuation.resume() }
        }
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        guard self.browser === controller else { return }
        let cancel = self.onCancel
        let intentID = self.intentID
        cancel?()
        if let intentID {
            Task { await self.dismiss(intentID: intentID) }
        }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard self.browser === presentationController.presentedViewController else { return }
        let cancel = self.onCancel
        self.browser = nil
        self.intentID = nil
        self.onCancel = nil
        self.presentation = nil
        cancel?()
    }
}
