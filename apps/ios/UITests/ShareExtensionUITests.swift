import UIKit
import XCTest

/// Drives the real share-sheet path: Photos -> share -> OpenClaw compose card.
/// The ordinary case expects an unpaired simulator. Integration cases opt in
/// to manually prepared, task-owned fixtures; see apps/ios/README.md.
final class ShareExtensionUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testComposeCardStatesInShareSheet() throws {
        try XCTSkipIf(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_SHARE_PROOF"] != nil,
            "Run the unpaired case separately without OPENCLAW_IOS_SHARE_PROOF.")
        try exerciseShare(mode: nil)
    }

    func testAdmissionResponsesInRealShareSheet() throws {
        try requireProofMode(.wire)
        for mode in ["message_too_large", "invalid_attachments", "legacy", "malformed", "wrong_event", "rpc_error", "disconnect", "held", "accepted"] {
            var request = try URLRequest(url: XCTUnwrap(URL(string: "http://127.0.0.1:19876/mode")))
            request.httpMethod = "POST"
            request.httpBody = Data(mode.utf8)
            let changed = expectation(description: "Wire fixture scenario configured")
            URLSession.shared.dataTask(with: request) { _, response, error in
                XCTAssertNil(error)
                XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                changed.fulfill()
            }.resume()
            wait(for: [changed], timeout: 5)
            try exerciseShare(mode: mode)
        }
    }

    func testRealGatewayAcceptedShare() throws {
        try requireProofMode(.gateway)
        try exerciseShare(mode: "accepted")
    }

    func testRealGatewayOversizedShare() throws {
        try requireProofMode(.gateway)
        try exerciseShare(mode: "real_oversized")
    }

    private enum ProofMode: String {
        case wire, gateway
    }

    private func requireProofMode(_ expected: ProofMode) throws {
        guard let value = ProcessInfo.processInfo.environment["OPENCLAW_IOS_SHARE_PROOF"] else {
            throw XCTSkip("Prepare a dedicated simulator and owned Share fixtures, then set " +
                "TEST_RUNNER_OPENCLAW_IOS_SHARE_PROOF=wire or gateway; see apps/ios/README.md.")
        }
        let selected = try XCTUnwrap(ProofMode(rawValue: value), "OPENCLAW_IOS_SHARE_PROOF must be wire or gateway.")
        try XCTSkipUnless(selected == expected, "Requires OPENCLAW_IOS_SHARE_PROOF=" + expected.rawValue)
    }

    private func exerciseShare(mode: String?) throws {
        let photos = XCUIApplication(bundleIdentifier: "com.apple.mobileslideshow")
        addUIInterruptionMonitor(withDescription: "Photos notifications") { alert in
            for title in ["Don’t Allow", "Don't Allow", "Not Now"] where alert.buttons[title].exists {
                alert.buttons[title].tap()
                return true
            }
            return false
        }
        photos.launch()
        photos.tap()

        // Photos intermittently shows a "What's New" splash on launch.
        let continueButton = photos.buttons["Continue"].firstMatch
        if continueButton.waitForExistence(timeout: 3) {
            continueButton.tap()
        }

        // Photos restores its last view on launch; only drill into the grid when
        // no photo detail (with its Share button) is already on screen.
        let shareButton = photos.buttons["Share"].firstMatch
        if !shareButton.waitForExistence(timeout: 5) {
            try openFirstPhoto(in: photos)
            if !shareButton.waitForExistence(timeout: 5) {
                try openFirstPhoto(in: photos)
            }
            XCTAssertTrue(shareButton.waitForExistence(timeout: 10), "Photo detail share button missing")
        }
        tapShareButton(shareButton, in: photos)

        // Target the share-sheet app cell explicitly; label-only matching can hit
        // other OpenClaw builds installed on the same simulator.
        let openClawOption = photos.cells.matching(identifier: "shareCell")
            .matching(NSPredicate(format: "label BEGINSWITH 'OpenClaw'"))
            .firstMatch
        XCTAssertTrue(openClawOption.waitForExistence(timeout: 10), "OpenClaw missing from share sheet")
        openClawOption.tap()

        let draft = photos.textViews["share-compose.draft"]
        let send = photos.buttons["share-compose.send"]
        let cancel = photos.buttons["share-compose.cancel"]
        XCTAssertTrue(draft.waitForExistence(timeout: 15), "Compose draft field missing")
        XCTAssertTrue(send.waitForExistence(timeout: 10), "Send button missing")
        XCTAssertTrue(cancel.exists, "Cancel button missing")

        // Send is also disabled while preparing; wait for the preparing footer to
        // clear so the empty-draft assertions target the ready state.
        let preparing = photos.staticTexts["Preparing share…"]
        XCTAssertTrue(
            waitForNonExistence(of: preparing, timeout: 30),
            "Draft preparation did not finish"
        )

        // Image-only share prepares an empty draft: placeholder guidance, send locked.
        XCTAssertTrue(
            waitFor(send, enabled: false, timeout: 10),
            "Send must stay disabled for an empty draft"
        )
        attachScreenshot(of: photos, named: "compose-empty-draft")

        draft.tap()
        let originalDraft = mode == "real_oversized" ? String(repeating: "x", count: 20001) : "Describe this image"
        if mode == "real_oversized" {
            UIPasteboard.general.string = originalDraft
            draft.press(forDuration: 1.0)
            let paste = photos.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Paste")).firstMatch
            XCTAssertTrue(paste.waitForExistence(timeout: 5), "Paste action missing")
            paste.tap()
            let allow = photos.alerts.buttons["Allow Paste"]
            if allow.waitForExistence(timeout: 2) {
                allow.tap()
            }
            XCTAssertEqual(draft.value as? String, originalDraft)
        } else {
            draft.typeText(originalDraft)
        }
        XCTAssertTrue(
            waitFor(send, enabled: true, timeout: 10),
            "Send must enable once the draft has text"
        )
        attachScreenshot(of: photos, named: "compose-ready")

        // The default case is unpaired; opted-in cases use the prepared relay.
        // Rejection must surface inline and return control for edits.
        send.tap()
        if mode == "held" {
            XCTAssertFalse(send.isEnabled, "Pending admission must lock Send")
            XCTAssertFalse(cancel.isEnabled, "Pending admission must lock Cancel")
            XCTAssertEqual(draft.value as? String, originalDraft)
        }
        if mode == "accepted" {
            XCTAssertTrue(waitForNonExistence(of: draft, timeout: 30), "Accepted share must dismiss")
            XCTAssertTrue(shareButton.waitForExistence(timeout: 10))
            attachScreenshot(of: photos, named: "admission-accepted-dismissed")
            return
        }
        let failure = photos.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Send failed'")).firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 30), "Send failure status missing")
        XCTAssertTrue(
            waitFor(send, enabled: true, timeout: 10),
            "Send must re-enable after a failure"
        )
        XCTAssertEqual(draft.value as? String, originalDraft, "Failure must retain the exact draft")
        if let mode {
            let expected: String?
            switch mode {
            case "message_too_large", "real_oversized": expected = "The message is too long. Shorten it and try again."
            case "invalid_attachments": expected = "The Gateway could not accept the attachments. Remove them and share again."
            case "legacy", "malformed", "wrong_event": expected = "Gateway admission could not be confirmed. Check OpenClaw before retrying, and update your Gateway."
            default: expected = nil
            }
            if let expected {
                XCTAssertTrue(failure.label.contains(expected), failure.label)
            }
            draft.tap()
            draft.typeText(" edited")
            let edited = draft.value as? String ?? ""
            XCTAssertEqual(edited.replacingOccurrences(of: " edited", with: ""), originalDraft,
                           "Original draft must survive an insertion at any cursor position")
            XCTAssertTrue(edited.contains(" edited"), "Failure must restore editing")
            XCTAssertEqual(edited.count, originalDraft.count + " edited".count)
        }
        attachScreenshot(of: photos, named: "admission-" + (mode ?? "unpaired"))

        cancel.tap()
        XCTAssertTrue(shareButton.waitForExistence(timeout: 10), "Share sheet did not dismiss on cancel")
    }

    private func openFirstPhoto(in photos: XCUIApplication) throws {
        let photoGrid = photos.buttons["all_photos_grid"]
        if photoGrid.waitForExistence(timeout: 5) {
            // iPadOS 18 exposes the whole top thumbnail strip as one grid button.
            photoGrid.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.9)).tap()
            return
        }

        let firstPhoto = photos.scrollViews.images.firstMatch
        guard firstPhoto.waitForExistence(timeout: 10) else {
            throw XCTSkip("Photos library has no images; seed one with `xcrun simctl addmedia`.")
        }
        firstPhoto.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func tapShareButton(_ shareButton: XCUIElement, in photos: XCUIApplication) {
        if shareButton.isHittable {
            shareButton.tap()
            return
        }

        let window = photos.windows.firstMatch
        let windowFrame = window.frame
        let buttonFrame = shareButton.frame
        guard !windowFrame.isEmpty, !buttonFrame.isEmpty else {
            XCTFail("Photos window or Share button has no frame")
            return
        }
        let point = CGVector(
            dx: buttonFrame.midX / windowFrame.width,
            dy: buttonFrame.midY / windowFrame.height
        )
        photos.coordinate(withNormalizedOffset: point).tap()
    }

    private func waitFor(_ element: XCUIElement, enabled: Bool, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "isEnabled == %@", NSNumber(value: enabled))
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForNonExistence(of element: XCUIElement, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func attachScreenshot(of app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
