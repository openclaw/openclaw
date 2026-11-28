import UIKit
import Vision
import XCTest

extension OpenClawSnapshotUITests {
    func testMessageTimesAppearOnlyWhileHoldingLeftDrag() throws {
        XCUIDevice.shared.orientation = .portrait
        self.launchApp(
            for: Self.chatScreenshotTarget,
            appearance: "light",
            additionalArguments: ["--openclaw-reaction-tool-fixture"])
        let app = try XCTUnwrap(self.app)
        let first = app.staticTexts["Hello"]
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        let before = first.frame
        let expectedLines = ["Hello", "Hi! I’m here.", "Great", "React to my message with an emoji"].map {
            app.staticTexts[$0].frame.midY
        }
        let body = app.descendants(matching: .any)["chat-user-message-body"].firstMatch
        let clock = try XCTUnwrap(body.value as? String)
        XCTAssertTrue(clock.contains(":"), "VoiceOver must get the time without dragging")
        XCTAssertFalse(app.staticTexts["Just now"].exists)
        XCTAssertFalse(app.staticTexts[clock].exists)

        // The column is visual only. Inspect its actual pixels instead of manufacturing
        // accessibility elements or a latched debug state for the test.
        let screenshot = try self.heldClockScreenshot(on: first, named: "clock-held")
        let lines = try self.clockLines(screenshot, height: app.frame.height)
        XCTAssertEqual(lines.count, expectedLines.count, "One clock for each message, none for the tool row")
        for (clockY, messageY) in zip(lines, expectedLines) {
            XCTAssertEqual(clockY, messageY, accuracy: 7, "Clock must sit on its message’s first text line")
        }
        XCTAssertEqual(first.frame, before, "The first visible message must spring back without a vertical shift")
        XCTAssertTrue(try self.clockLines(XCUIScreen.main.screenshot(), height: app.frame.height).isEmpty)
    }

    func testOlderMessageTimesStayWithEachBubbleAndPhoto() throws {
        XCUIDevice.shared.orientation = .portrait
        self.launchApp(
            for: Self.chatScreenshotTarget,
            appearance: "light",
            additionalArguments: ["--openclaw-clock-media-fixture"])
        let app = try XCTUnwrap(self.app)
        let first = app.staticTexts["From yesterday"]
        let photo = app.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ OR label == %@",
            "Mountain view",
            "landscape.png")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertTrue(photo.waitForExistence(timeout: 5))
        let centers = [first.frame.midY, app.staticTexts["Here’s the view"].frame.midY, photo.frame.midY]
        let held = try self.heldClockScreenshot(on: first, named: "clock-media-held")
        let lines = try self.clockLines(held, height: app.frame.height)
        XCTAssertEqual(lines.count, 3)
        for (line, center) in zip(lines, centers) {
            XCTAssertEqual(line, center, accuracy: 12, "The two-line stamp belongs beside this message or photo")
        }
    }

    private func heldClockScreenshot(on message: XCUIElement, named name: String) throws -> XCUIScreenshot {
        let start = message.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = start.withOffset(CGVector(dx: -85, dy: 3))
        var held: XCUIScreenshot?
        let timer = Timer(timeInterval: 1, repeats: false) { _ in
            MainActor.assumeIsolated { held = XCUIScreen.main.screenshot() }
        }
        RunLoop.main.add(timer, forMode: .common)
        defer { timer.invalidate() }
        start.press(forDuration: 0.07, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 2)
        let screenshot = try XCTUnwrap(held)
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
        return screenshot
    }

    private func clockLines(_ screenshot: XCUIScreenshot, height: CGFloat) throws -> [CGFloat] {
        let recognition = VNRecognizeTextRequest()
        recognition.recognitionLevel = .accurate
        recognition.usesLanguageCorrection = false
        // Restrict recognition to the rail: full-screen OCR can join a bubble and a clock
        // into a single line. Exclude the stationary header and composer.
        let image = try XCTUnwrap(screenshot.image.cgImage)
        let edge = (CGFloat(image.width) * 0.82).rounded(.up)
        let y = (CGFloat(image.height) * 0.16).rounded(.up)
        let rail = CGRect(x: edge, y: y, width: CGFloat(image.width) - edge, height: CGFloat(image.height) * 0.68)
        try VNImageRequestHandler(cgImage: XCTUnwrap(image.cropping(to: rail))).perform([recognition])
        return (recognition.results ?? []).filter {
            $0.topCandidates(1).first?.string
                .range(of: #"[0-9]{1,2}:[0-9]{2}"#, options: .regularExpression) != nil
        }.map { (y + (1 - $0.boundingBox.midY) * rail.height) / CGFloat(image.height) * height }.sorted()
    }
}
