import UIKit
import XCTest
@testable import OpenClawChatUI

@MainActor
final class ChatNativePrependViewportTests: XCTestCase {
    func testLayoutCompletionCorrectsBeforeReleasingAndContinuing() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        window.rootViewController = controller
        window.isHidden = false
        let scrollView = UIScrollView(frame: window.bounds)
        controller.view.addSubview(scrollView)
        let viewport = ChatNativePrependViewport()
        viewport.attach(to: scrollView)
        defer {
            viewport.detach()
            window.isHidden = true
        }
        // Drive the actual display-link selector deterministically, without waiting for screen refresh.
        let finishFrame = NSSelectorFromString("finishFrame")
        XCTAssertTrue(viewport.responds(to: finishFrame))
        for displacement in [CGFloat(0), CGFloat(1000)] {
            scrollView.contentSize = CGSize(width: 390, height: 3000)
            scrollView.contentOffset = CGPoint(x: 0, y: 300)
            let rowID = UUID()
            viewport.capture(row: ChatScrollRowGeometry(targetID: rowID, preservationID: nil, contentMinY: 400))
            var continued = false
            XCTAssertTrue(viewport.pageArrived(afterLayout: {
                XCTAssertFalse(viewport.isPreserving, "Release must precede the next capture")
                XCTAssertEqual(scrollView.contentOffset.y, 300 + displacement, "Correct before continuing")
                continued = true
            }))
            XCTAssertFalse(continued)
            if displacement == 0 {
                _ = viewport.perform(finishFrame)
                XCTAssertTrue(viewport.isPreserving, "An unchanged sample gets the first-layout grace frame")
                XCTAssertFalse(continued)
            } else {
                viewport.update(row: ChatScrollRowGeometry(
                    targetID: rowID, preservationID: nil, contentMinY: 400 + displacement))
                XCTAssertEqual(scrollView.contentOffset.y, 300 + displacement)
                XCTAssertTrue(viewport.isPreserving)
                XCTAssertFalse(continued)
            }
            _ = viewport.perform(finishFrame)
            XCTAssertTrue(continued)
            XCTAssertFalse(viewport.isPreserving)
        }
    }

    func testPrependIgnoresReplyGrowthBelowReadingRow() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        window.rootViewController = controller
        window.isHidden = false
        let scrollView = UIScrollView(frame: window.bounds)
        controller.view.addSubview(scrollView)
        let viewport = ChatNativePrependViewport()
        viewport.attach(to: scrollView)
        defer {
            viewport.detach()
            window.isHidden = true
        }
        let rowID = UUID()
        for growsBeforePage in [true, false] {
            scrollView.contentSize = CGSize(width: 390, height: 2000)
            scrollView.contentOffset = CGPoint(x: 0, y: 300)
            viewport.capture(row: ChatScrollRowGeometry(targetID: rowID, preservationID: nil, contentMinY: 400))
            if growsBeforePage { scrollView.contentSize.height += 200 }
            XCTAssertTrue(viewport.pageArrived())
            if !growsBeforePage { scrollView.contentSize.height += 200 }
            XCTAssertEqual(scrollView.contentOffset.y, 300, "Tail growth alone must not move the reader")
            scrollView.contentSize.height += 1000
            viewport.update(row: ChatScrollRowGeometry(targetID: rowID, preservationID: nil, contentMinY: 1400))
            XCTAssertEqual(scrollView.contentOffset.y, 1300, "Only the 1000-point prepend belongs above the row")
            viewport.cancel()
        }
    }
}
