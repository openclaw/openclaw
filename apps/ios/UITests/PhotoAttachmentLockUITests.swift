import Foundation
import XCTest

/// Run only on a task-owned simulator seeded with a synthetic photo newer than its stock sample photos.
/// Default fixture transport tests native interaction, not Gateway image delivery.
@MainActor
final class PhotoAttachmentLockUITests: XCTestCase {
    private var startedAt = Date()

    override func setUpWithError() throws {
        continueAfterFailure = false
        startedAt = Date()
    }

    func testControlWithoutPhoto() {
        let app = launchApp()
        exerciseComposer(in: app)
    }

    func testWithNativePhotoPickerAttachment() {
        let app = launchApp()
        let attachments = app.buttons["chat-attachment-picker"]
        let exists = traced("query composer-options existence") { attachments.waitForExistence(timeout: 8) }
        XCTAssertTrue(exists)
        let frame = traced("query composer-options frame") { attachments.frame }
        XCTAssertFalse(frame.isEmpty)
        // iOS 27 reports this visible SwiftUI Menu as non-hittable. Its center
        // was verified through independent HID input; assert the resulting menu.
        traced("tap visible composer-options center") {
            attachments.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        let library = app.buttons["Photo Library"]
        requireVisible(library, named: "Photo Library")
        traced("tap Photo Library") { library.tap() }

        // Validate these system-owned selectors against the tested iOS version.
        // A missing picker/cell/Done button is a setup failure, not a composer lock.
        // Validated on iOS 27: picker thumbnails are PXGGridLayout-Info images,
        // and the confirmation action is Done, not Add. The newest photo is the
        // task's synthetic fixture, ahead of the simulator's stock sample photos.
        let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH %@", "Photo,")).firstMatch
        requireVisible(photo, named: "SETUP: synthetic system picker photo")
        traced("tap synthetic system picker photo center") {
            photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        let done = app.navigationBars["Photos"].buttons["Done"]
        requireVisible(done, named: "SETUP: system picker Done")
        let selectionEnabled = traced("query picker selection accepted") { done.isEnabled }
        XCTAssertTrue(selectionEnabled)
        traced("tap system picker Done") {
            done.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }

        let attachment = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "photo-")).firstMatch
        requireVisible(attachment, named: "staged photo attachment")
        exerciseComposer(in: app, withPhoto: true)
    }

    private func launchApp() -> XCUIApplication {
        guard ProcessInfo.processInfo.environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1" else {
            return launchFixture()
        }
        // Opt-in live runs require an app already paired with an isolated test Gateway.
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-tab", "chat", "--openclaw-initial-destination", "chat",
            "--openclaw-sidebar-visibility", "hidden",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        traced("launch paired isolated Gateway app") { app.launch() }
        let sidebar = app.buttons["RootTabs.Sidebar.Show"]
        requireVisible(sidebar, named: "sidebar reveal")
        traced("open sidebar") { sidebar.tap() }
        let newChat = app.buttons["New Chat"]
        requireVisible(newChat, named: "New Chat")
        XCTAssertTrue(newChat.isEnabled)
        XCTAssertTrue(newChat.isHittable)
        traced("start fresh isolated chat") { newChat.tap() }
        requireVisible(sidebar, named: "sidebar closed after New Chat")
        return app
    }

    private func launchFixture() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-screenshot-mode",
            "--openclaw-initial-tab", "chat",
            "--openclaw-initial-destination", "chat",
            "--openclaw-sidebar-visibility", "hidden",
            "--openclaw-ui-test-readiness",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        traced("launch fixture app") { app.launch() }
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"]
        let readyExists = traced("query root readiness existence (8s maximum)") {
            readiness.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(readyExists, "Root readiness marker must exist")
        let readyValue = traced("query root readiness value") { readiness.value as? String }
        XCTAssertEqual(readyValue, "ready:chat")
        return app
    }

    private func exerciseComposer(in app: XCUIApplication, withPhoto: Bool = false) {
        let input = app.descendants(matching: .any)["chat-message-input"]
        requireVisible(input, named: "composer input")
        assertDraft("", in: input)
        traced("tap composer input") { input.tap() }
        var expected = ""
        for character in "abcdefgh" {
            if !expected.isEmpty {
                traced("one-second typing interval") { Thread.sleep(forTimeInterval: 1) }
            }
            let next = String(character)
            traced("type character \(expected.count + 1)") { input.typeText(next) }
            expected.append(character)
            assertDraft(expected, in: input)
        }

        let send = app.buttons["chat-send-message"]
        requireVisible(send, named: "Send")
        let enabled = traced("query Send enabled") { send.isEnabled }
        XCTAssertTrue(enabled, "Send must be enabled after the eight-character draft")
        let hittable = traced("query Send hittable") { send.isHittable }
        XCTAssertTrue(hittable, "Send must be hittable without dismissing the keyboard")
        traced("tap Send") { send.tap() }
        let recovered = traced("wait for empty, enabled, hittable composer after Send (45s maximum)") {
            let ready = NSPredicate { _, _ in
                input.exists && input.isEnabled && input.isHittable && (input.value as? String) == ""
            }
            return XCTWaiter.wait(
                for: [XCTNSPredicateExpectation(predicate: ready, object: input)],
                timeout: 45
            ) == .completed
        }
        guard recovered else {
            XCTFail("Composer must clear and recover after Send before entering the next draft")
            return
        }
        assertDraft("", in: input)
        traced("tap composer after Send") { input.tap() }
        traced("type next draft character") { input.typeText("z") }
        assertDraft("z", in: input)
        let replyKey = withPhoto ? "OPENCLAW_IOS_EXPECTED_PHOTO_REPLY" : "OPENCLAW_IOS_EXPECTED_TEXT_REPLY"
        if let reply = ProcessInfo.processInfo.environment[replyKey] {
            let received = traced("wait for isolated Gateway provider reply") {
                app.staticTexts[reply].waitForExistence(timeout: 45)
            }
            XCTAssertTrue(received, "Real Gateway must deliver the synthetic provider reply")
            assertDraft("z", in: input)
            let proof = XCTAttachment(screenshot: app.screenshot())
            proof.name = withPhoto ? "connected-photo-reply-next-draft" : "connected-control-reply-next-draft"
            proof.lifetime = .keepAlways
            add(proof)
        }
    }

    private func requireVisible(_ element: XCUIElement, named name: String) {
        let exists = traced("query \(name) existence (8s maximum)") {
            element.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(exists, "\(name) must exist")
        let frame = traced("query \(name) visible frame") { element.frame }
        XCTAssertFalse(frame.isEmpty, "\(name) must have a visible frame")
    }

    private func assertDraft(_ expected: String, in input: XCUIElement) {
        let value = traced("query draft value; expected length \(expected.count)") { input.value as? String }
        XCTAssertEqual(value, expected)
    }

    @discardableResult
    private func traced<T>(_ name: String, _ operation: () -> T) -> T {
        marker("BEFORE", name)
        let result = operation()
        marker("AFTER", name)
        return result
    }

    private func marker(_ phase: String, _ name: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let elapsed = String(format: "%.3f", Date().timeIntervalSince(startedAt))
        let line = "PHOTO_LOCK \(timestamp) +\(elapsed)s \(phase) \(name)\n"
        // Write immediately: the last BEFORE marker must survive an AX/idle stall.
        FileHandle.standardOutput.write(Data(line.utf8))
    }
}
