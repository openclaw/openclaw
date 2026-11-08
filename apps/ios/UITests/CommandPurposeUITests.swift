import UIKit
import Vision
import XCTest

@MainActor
final class CommandPurposeUITests: XCTestCase {
    func testCommandStepShowsSuppliedPurposeTitle() throws {
        let app = XCUIApplication()
        setupSnapshot(app)
        app.launchArguments += [
            "--openclaw-initial-tab", "chat",
            "--openclaw-initial-destination", "chat",
            "--openclaw-sidebar-visibility", "hidden",
            "--openclaw-ui-test-readiness", "--openclaw-screenshot-mode",
            "--openclaw-appearance", "dark",
            "--openclaw-step-labels-fixture", "--openclaw-command-purpose-fixture",
        ]
        continueAfterFailure = false
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"]
        XCTAssertTrue(readiness.waitForExistence(timeout: 8))
        let ready = NSPredicate(format: "value == %@", "ready:chat")
        expectation(for: ready, evaluatedWith: readiness)
        waitForExpectations(timeout: 8)
        XCTAssertTrue(app.staticTexts["Local readiness checked."].waitForExistence(timeout: 8))
        let work = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked")).firstMatch
        XCTAssertTrue(work.waitForExistence(timeout: 5))
        work.tap()
        let row = app.descendants(matching: .any).matching(NSPredicate(
            format: "value CONTAINS %@", "printf ready")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "command-purpose-expanded"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertTrue(row.label.contains("Check local readiness"), "Supplied command purpose is missing: \(row.label)")
        let recognition = VNRecognizeTextRequest()
        recognition.recognitionLevel = .accurate
        recognition.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(cgImage: XCTUnwrap(row.screenshot().image.cgImage), options: [:])
            .perform([recognition])
        let text = (recognition.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: " ").lowercased()
        XCTAssertTrue(text.contains("check local readiness"), "Rendered purpose missing: \(text)")
    }
}
