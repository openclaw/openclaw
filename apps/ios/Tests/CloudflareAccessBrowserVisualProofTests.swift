import SafariServices
import Testing
import UIKit
import XCTest
@testable import OpenClaw

@MainActor
final class CloudflareAccessBrowserVisualProofTests: XCTestCase {
    func testSignInOffersAnotherAccount() async throws {
        // Host the production alert, not a reconstructed fixture. No website or account is opened.
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let root = UIViewController()
        root.view.backgroundColor = .systemBackground
        window.rootViewController = root
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            previousKeyWindow?.makeKeyAndVisible()
        }

        var visiblePrompt: UIAlertController?
        let presenter = CloudflareAccessBrowserPresenter(
            present: { _ in XCTFail("The proof must not open a website") },
            dismiss: { _ in },
            presentPrompt: { prompt in
                await withCheckedContinuation { continuation in
                    root.present(prompt, animated: false) { continuation.resume() }
                }
                visiblePrompt = prompt
            },
            dismissPrompt: { prompt in
                await withCheckedContinuation { continuation in
                    prompt.dismiss(animated: false) { continuation.resume() }
                }
            })
        let origin = try CloudflareAccessOrigin(XCTUnwrap(URL(string: "https://gateway.example.test")))
        let id = UUID()
        let preparing = Task { try await presenter.prepare(origin, intentID: id) {} }
        defer { preparing.cancel() }
        try await waitForIngress { visiblePrompt != nil }
        let prompt = try XCTUnwrap(visiblePrompt)
        XCTAssertTrue(prompt.presentingViewController === root)
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "cloudflare-access-account-choice"
        attachment.lifetime = .keepAlways
        self.add(attachment)

        // Capture before this assertion so the same test retains the original missing-action proof.
        XCTAssertTrue(prompt.actions.contains { $0.title == "Use another account" })
        preparing.cancel()
        _ = await preparing.result
        await presenter.dismiss(intentID: id)
    }
}
