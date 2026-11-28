import XCTest

extension OpenClawSnapshotUITests {
    func testPhotoStackOpensAtFirstImageAndPagesThroughTheEntireMessage() throws {
        let target = ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "photo-album")
        self.launchApp(for: target, appearance: "dark", additionalArguments: ["--openclaw-photo-album-fixture", "9"])
        let app = try XCTUnwrap(self.app)
        // On the base, tap the first tile instead: the actual viewer opens, but only has four pages.
        let album = app.buttons["9 images"]
        let opener = album.waitForExistence(timeout: 2) ? album : app.buttons["Study 1"]
        XCTAssertTrue(opener.waitForExistence(timeout: 5))
        opener.tap()
        // The bar's combined element shares the position text's identifier; match by label.
        let positions = app.staticTexts.matching(identifier: "chat-image-viewer-position")
        for page in 1...9 {
            if page > 1 { app.swipeLeft() }
            let position = positions.matching(NSPredicate(format: "label == %@", "\(page) of 9")).firstMatch
            XCTAssertTrue(position.waitForExistence(timeout: 3), "page \(page)")
        }
    }
}
