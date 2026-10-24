import UIKit
import XCTest
@testable import OpenClawChatUI

@MainActor
final class ChatNativePrependViewportTests: XCTestCase {
    private var window: UIWindow!
    private var scrollView: UIScrollView!
    private var anchor: UIView!
    private var viewport: ChatNativePrependViewport!

    override func setUp() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        window.rootViewController = controller
        window.isHidden = false
        let scrollView = UIScrollView(frame: window.bounds)
        controller.view.addSubview(scrollView)
        scrollView.contentSize = CGSize(width: 390, height: 3000)
        scrollView.contentOffset = CGPoint(x: 0, y: 300)
        let anchor = UIView(frame: CGRect(x: 0, y: 400, width: 1, height: 1))
        scrollView.addSubview(anchor)
        let viewport = ChatNativePrependViewport()
        viewport.attach(to: scrollView)
        (self.window, self.scrollView, self.anchor, self.viewport) = (window, scrollView, anchor, viewport)
    }

    override func tearDown() async throws {
        self.viewport.detach()
        self.window.isHidden = true
    }

    /// Drives the display-link selector deterministically, without waiting for a screen refresh.
    private func tick() {
        _ = self.viewport.perform(NSSelectorFromString("frameTick"))
    }

    private var landedCount = 0

    private func land() {
        self.viewport.capture()
        XCTAssertTrue(self.viewport.pageArrived(anchor: self.anchor) { _ in self.landedCount += 1 })
    }

    func testPrependCorrectsInTheLayoutPassAndFollowsTheRow() {
        self.land()
        // SwiftUI sets the content size before it moves the rows: the size change is applied at once.
        self.scrollView.contentSize.height += 1000
        XCTAssertEqual(self.scrollView.contentOffset.y, 1300)
        self.anchor.frame.origin.y = 1400
        self.tick()
        XCTAssertEqual(self.scrollView.contentOffset.y, 1300, "The row arrived where the size change put it")
        // A row above that finishes sizing later is followed by the row's own movement.
        self.anchor.frame.origin.y = 1460
        self.tick()
        XCTAssertEqual(self.scrollView.contentOffset.y, 1360)
        XCTAssertTrue(self.viewport.isPending)
    }

    func testStaleRowPositionInTheSamePassDoesNotUndoTheCorrection() {
        self.land()
        self.scrollView.contentSize.height += 1000
        // A second size change in the same pass still reads the row at its pre-page position.
        self.scrollView.contentSize.height += 1
        XCTAssertEqual(self.scrollView.contentOffset.y, 1300)
        self.tick()
        XCTAssertEqual(self.scrollView.contentOffset.y, 1300, "The old view is waited out, not followed back")
        self.anchor.frame.origin.y = 1400
        self.tick()
        XCTAssertEqual(self.scrollView.contentOffset.y, 1300)
    }

    func testGrowthBelowTheRowDoesNotMoveTheReader() {
        self.land()
        self.scrollView.contentSize.height += 1000
        self.anchor.frame.origin.y = 1400
        self.tick()
        // A live row below the reader grows: the row does not move, so neither does the reader.
        self.scrollView.contentSize.height += 500
        self.tick()
        XCTAssertEqual(self.scrollView.contentOffset.y, 1300)
    }

    func testGrowthBelowBeforeThePageIsUndoneWhenTheRowDoesNotMove() {
        self.land()
        // A live row below grows before the page's rows move: the first size change looks like the prepend.
        self.scrollView.contentSize.height += 200
        XCTAssertEqual(self.scrollView.contentOffset.y, 500)
        for _ in 0..<3 {
            self.tick()
        }
        XCTAssertEqual(self.scrollView.contentOffset.y, 300, "The row never moved, so the reader must not either")
        // The page then lands and is followed by the row's own movement.
        self.anchor.frame.origin.y = 1400
        self.tick()
        XCTAssertEqual(self.scrollView.contentOffset.y, 1300)
    }

    func testLandingThatSettlesReportsSoPagingContinues() {
        self.land()
        self.scrollView.contentSize.height += 1000
        self.anchor.removeFromSuperview()
        self.tick()
        XCTAssertFalse(self.viewport.isPending)
        XCTAssertEqual(self.landedCount, 1)
    }

    func testCancelledLandingDoesNotReport() {
        self.land()
        self.viewport.cancel()
        XCTAssertFalse(self.viewport.isPending)
        self.tick()
        XCTAssertEqual(self.landedCount, 0)
    }

    func testMissingAnchorDeclinesNativeLandingWithoutMovingReader() {
        self.viewport.capture()
        XCTAssertFalse(self.viewport.pageArrived(anchor: nil) { _ in self.landedCount += 1 })
        XCTAssertFalse(self.viewport.isPending)
        // A live reply below can grow before the prepend. Size cannot identify its direction.
        self.scrollView.contentOffset.y = 350
        self.scrollView.contentSize.height += 200
        XCTAssertEqual(self.scrollView.contentOffset.y, 350)
        self.scrollView.contentSize.height += 1000
        self.tick()
        XCTAssertEqual(self.scrollView.contentOffset.y, 350)
        XCTAssertEqual(self.landedCount, 0)
    }

    func testDisconnectedAnchorDeclinesNativeLandingWithoutMovingReader() {
        self.anchor.removeFromSuperview()
        self.viewport.capture()
        XCTAssertFalse(self.viewport.pageArrived(anchor: self.anchor))
        XCTAssertFalse(self.viewport.isPending)
        self.scrollView.contentOffset.y = 350
        self.scrollView.contentSize.height += 1000
        self.tick()
        XCTAssertEqual(self.scrollView.contentOffset.y, 350)
    }

    func testConnectedLandingPreservesInterveningScrollAndIgnoresGrowthBelow() {
        self.land()
        self.scrollView.contentOffset.y = 350
        self.scrollView.contentSize.height += 1000
        XCTAssertEqual(self.scrollView.contentOffset.y, 1350)
        self.anchor.frame.origin.y = 1400
        self.tick()
        self.scrollView.contentOffset.y = 1375
        self.scrollView.contentSize.height += 200
        self.scrollView.contentSize.height += 1
        self.tick()
        XCTAssertEqual(self.scrollView.contentOffset.y, 1375)
    }

    func testMissingAnchorPreservesInsetAndOverscroll() {
        self.scrollView.contentInset.top = 20
        self.scrollView.contentOffset.y = -40
        self.viewport.capture()
        XCTAssertFalse(self.viewport.pageArrived(anchor: nil))
        self.scrollView.contentSize.height += 1000
        self.tick()
        XCTAssertEqual(self.scrollView.contentOffset.y, -40)
    }
}
