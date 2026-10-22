import SafariServices
import UIKit

@MainActor
protocol CloudflareAccessBrowserPresenting: AnyObject {
    func prepare(_ origin: CloudflareAccessOrigin, intentID: UUID, onCancel: @escaping () -> Void) async throws
    func open(_ url: URL, intentID: UUID, onCancel: @escaping () -> Void) async throws
    func dismiss(intentID: UUID) async
}

/// Browser navigation never proves authentication; only the encrypted transfer can admit a session.
@MainActor
final class CloudflareAccessBrowserPresenter: NSObject, @MainActor SFSafariViewControllerDelegate,
    UIAdaptivePresentationControllerDelegate, CloudflareAccessBrowserPresenting
{
    private enum Phase { case introduction, website, confirmation, transfer }
    private var controller: UIViewController?
    private var phase: Phase?
    private var onCancel: (() -> Void)?
    private var intentID: UUID?
    private var requestedIntentID: UUID?
    private var presentation: Task<Void, Error>?
    private var dismissal: (id: UUID, task: Task<Void, Never>)?
    private var continuation: CheckedContinuation<Void, Error>?
    private var waitingStepID: UUID?
    private let presentBrowser: (SFSafariViewController) async throws -> Void
    private let dismissBrowser: (SFSafariViewController) async -> Void
    private let presentPrompt: (UIAlertController) async throws -> Void
    private let dismissPrompt: (UIAlertController) async -> Void

    init(
        present: @escaping (SFSafariViewController) async throws -> Void = CloudflareAccessBrowserPresenter.present,
        dismiss: @escaping (SFSafariViewController) async -> Void = CloudflareAccessBrowserPresenter.dismiss,
        presentPrompt: @escaping (UIAlertController) async throws -> Void = CloudflareAccessBrowserPresenter.present,
        dismissPrompt: @escaping (UIAlertController) async -> Void = CloudflareAccessBrowserPresenter.dismiss)
    {
        self.presentBrowser = present
        self.dismissBrowser = dismiss
        self.presentPrompt = presentPrompt
        self.dismissPrompt = dismissPrompt
        super.init()
    }

    func prepare(_ origin: CloudflareAccessOrigin, intentID: UUID, onCancel: @escaping () -> Void) async throws {
        try await self.claim(intentID: intentID, onCancel: onCancel)
        try await withTaskCancellationHandler {
            do {
                try await self.prompt(
                    title: "Sign in to your website",
                    message: "Sign in to the gateway website in the browser, then tap Done. " +
                        "You will return here to continue connecting OpenClaw.",
                    phase: .introduction,
                    intentID: intentID)
                try self.check(intentID)
                let browser = SFSafariViewController(url: origin.url)
                browser.dismissButtonStyle = .done
                browser.delegate = self
                try await self.waitForAction(browser, phase: .website, intentID: intentID)
                try self.check(intentID)
                try await self.prompt(
                    title: "Continue connecting?",
                    message: "If you finished signing in to the website, continue to securely connect OpenClaw. " +
                        "The next browser step verifies your access.",
                    phase: .confirmation,
                    intentID: intentID)
                try self.check(intentID)
            } catch {
                await self.dismiss(intentID: intentID)
                throw error
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(intentID: intentID) }
        }
    }

    func open(_ url: URL, intentID: UUID, onCancel: @escaping () -> Void) async throws {
        try await self.claim(intentID: intentID, onCancel: onCancel)
        let browser = SFSafariViewController(url: url)
        browser.dismissButtonStyle = .cancel
        browser.delegate = self
        do {
            try await self.show(browser, phase: .transfer, intentID: intentID)
        } catch {
            await self.dismiss(intentID: intentID)
            throw error
        }
    }

    private func claim(intentID: UUID, onCancel: @escaping () -> Void) async throws {
        try Task.checkCancellation()
        self.requestedIntentID = intentID
        if let dismissal {
            await dismissal.task.value
        }
        try Task.checkCancellation()
        guard self.requestedIntentID == intentID else { throw CancellationError() }
        if let previous = self.intentID, previous != intentID || controller != nil {
            await self.dismiss(intentID: previous)
        }
        try Task.checkCancellation()
        guard self.requestedIntentID == intentID else { throw CancellationError() }
        self.intentID = intentID
        self.onCancel = onCancel
    }

    private func check(_ intentID: UUID) throws {
        try Task.checkCancellation()
        guard self.intentID == intentID, self.requestedIntentID == intentID else { throw CancellationError() }
    }

    private func prompt(title: String, message: String, phase: Phase, intentID: UUID) async throws {
        // UIAlertController owns system typography and accessibility; it has no supported branded-font API.
        let prompt = UIAlertController(title: title, message: message, preferredStyle: .alert)
        prompt.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self, weak prompt] _ in
            guard let self, let prompt, self.controller === prompt, self.intentID == intentID else { return }
            self.cancel(intentID: intentID)
        })
        prompt.addAction(UIAlertAction(title: "Continue", style: .default) { [weak self, weak prompt] _ in
            guard let self, let prompt, self.controller === prompt, self.intentID == intentID else { return }
            self.continuePreparation(from: prompt)
        })
        try await self.waitForAction(prompt, phase: phase, intentID: intentID)
    }

    private func waitForAction(_ controller: UIViewController, phase: Phase, intentID: UUID) async throws {
        try self.check(intentID)
        let stepID = UUID()
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            self.waitingStepID = stepID
            // Install the waiter before presentation, including synchronous injected actions.
            Task { @MainActor in
                do {
                    try await self.show(controller, phase: phase, intentID: intentID)
                } catch {
                    // A rejected show may never assign its controller. Settle only its own waiter.
                    guard self.waitingStepID == stepID else { return }
                    self.finishStep(throwing: error)
                }
            }
        }
        try self.check(intentID)
        await self.drainController(intentID: intentID)
        try self.check(intentID)
    }

    private func show(_ controller: UIViewController, phase: Phase, intentID: UUID) async throws {
        try self.check(intentID)
        self.controller = controller
        self.phase = phase
        let presentation = Task {
            try self.check(intentID)
            guard self.controller === controller else { throw CancellationError() }
            if let browser = controller as? SFSafariViewController {
                try await self.presentBrowser(browser)
            } else if let prompt = controller as? UIAlertController {
                try await self.presentPrompt(prompt)
            }
        }
        self.presentation = presentation
        try await presentation.value
        try self.check(intentID)
        guard self.controller === controller else { throw CancellationError() }
        // UIKit owns alert dismissal. Only the Safari sheet supports our swipe-to-cancel delegate.
        if controller is SFSafariViewController {
            controller.presentationController?.delegate = self
        }
    }

    func continuePreparation(from prompt: UIAlertController) {
        guard self.controller === prompt, self.phase == .introduction || self.phase == .confirmation else { return }
        self.finishStep()
    }

    private func finishStep(throwing error: Error? = nil) {
        let continuation = self.continuation
        self.continuation = nil
        self.waitingStepID = nil
        if let error {
            continuation?.resume(throwing: error)
        } else {
            continuation?.resume()
        }
    }

    private func cancel(intentID: UUID) {
        guard self.intentID == intentID else { return }
        let cancel = self.onCancel
        self.onCancel = nil
        if self.requestedIntentID == intentID {
            self.requestedIntentID = nil
        }
        self.finishStep(throwing: CancellationError())
        cancel?()
        Task { await self.dismiss(intentID: intentID) }
    }

    func dismiss(intentID: UUID) async {
        guard self.intentID == intentID else {
            if let dismissal, dismissal.id == intentID {
                await dismissal.task.value
            }
            return
        }
        self.onCancel = nil
        if self.requestedIntentID == intentID {
            self.requestedIntentID = nil
        }
        self.finishStep(throwing: CancellationError())
        await self.drainController(intentID: intentID)
        if self.intentID == intentID {
            self.intentID = nil
        }
    }

    /// Stage transitions share UIKit's drain without retiring the enclosing sign-in intent.
    private func drainController(intentID: UUID) async {
        if let dismissal, dismissal.id == intentID {
            await dismissal.task.value
            return
        }
        guard self.intentID == intentID, let controller else { return }
        let presentation = self.presentation
        let task = Task {
            _ = await presentation?.result
            if let browser = controller as? SFSafariViewController {
                await self.dismissBrowser(browser)
            } else if let prompt = controller as? UIAlertController {
                await self.dismissPrompt(prompt)
            }
        }
        dismissal = (intentID, task)
        await task.value
        guard dismissal?.id == intentID else { return }
        dismissal = nil
        if self.controller === controller {
            self.controller = nil
            self.phase = nil
            self.presentation = nil
        }
    }

    private static func present(_ controller: UIViewController) async throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
            var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController
        else { throw CloudflareAccessError.loginFailed }
        while let presented = presenter.presentedViewController {
            presenter = presented
        }
        await withCheckedContinuation { continuation in
            presenter.present(controller, animated: true) { continuation.resume() }
        }
    }

    private static func dismiss(_ controller: UIViewController) async {
        guard controller.presentingViewController != nil else { return }
        await withCheckedContinuation { continuation in
            controller.dismiss(animated: true) { continuation.resume() }
        }
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        guard self.controller === controller, let intentID else { return }
        if self.phase == .website {
            self.finishStep()
        } else {
            self.cancel(intentID: intentID)
        }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard self.controller === presentationController.presentedViewController, let intentID else { return }
        self.cancel(intentID: intentID)
    }
}
