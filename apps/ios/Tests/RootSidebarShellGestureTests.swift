import SwiftUI
import Testing
@testable import OpenClaw

@MainActor
struct RootSidebarShellGestureTests {
    private typealias Drawer = RootSidebarShell<EmptyView, EmptyView>

    @Test func `release velocity follows the remaining displacement in either direction`() {
        for (velocity, remaining, expected): (CGFloat, CGFloat, Double) in [
            (130, 180, 130 / 180),
            (540, 180, 3),
            (-360, -180, 2),
            (360, -180, -2),
            (-360, 180, -2),
            (10000, 1, 8),
            (-10000, 1, -8),
            (500, 0, 0),
        ] {
            #expect(Drawer.normalizedSpringVelocity(velocity, remainingOffset: remaining) == expected)
        }
    }

    @Test(arguments: [false, true])
    func `owner visibility changes reject the remaining gesture even before commitment`(initialPresentation: Bool) {
        let committed: Drawer.DragDisposition = initialPresentation ? .closing : .opening
        for disposition: Drawer.DragDisposition? in [nil, committed, .rejected] {
            #expect(Drawer.dragDisposition(
                startLocation: CGPoint(x: 20, y: 100),
                translation: CGSize(width: initialPresentation ? -40 : 40, height: 0),
                isPresented: !initialPresentation,
                initialPresentation: initialPresentation,
                canOpenFromEdge: true,
                latchedDisposition: disposition) == .rejected)
        }
    }

    @Test(arguments: [false, true])
    func `only clearly horizontal drags commit`(isPresented: Bool) {
        let committed: Drawer.DragDisposition = isPresented ? .closing : .opening
        let cases: [(CGSize, Drawer.DragDisposition?)] = [
            (.zero, nil),
            (CGSize(width: 8, height: 0), nil),
            (CGSize(width: 8, height: 7), nil),
            (CGSize(width: 15, height: 0), nil),
            (CGSize(width: 16, height: 8), nil),
            (CGSize(width: 16, height: 7), committed),
            (CGSize(width: 30, height: -16), nil),
            (CGSize(width: 40, height: -19), committed),
            (CGSize(width: 8, height: 9), .rejected),
            (CGSize(width: -16, height: 0), .rejected),
        ]
        for (translation, expected) in cases {
            let translation = CGSize(
                width: isPresented ? -translation.width : translation.width,
                height: translation.height)
            #expect(Drawer.dragDisposition(
                startLocation: CGPoint(x: 20, y: 100),
                translation: translation,
                isPresented: isPresented,
                initialPresentation: isPresented,
                canOpenFromEdge: true,
                latchedDisposition: nil) == expected)
        }
    }

    @Test func `opening respects edge and navigation eligibility while closing works anywhere`() {
        let cases: [(CGPoint, Bool, Drawer.DragDisposition)] = [
            (CGPoint(x: 44, y: 45), true, .opening),
            (CGPoint(x: 45, y: 100), true, .rejected),
            (CGPoint(x: 20, y: 44), true, .rejected),
            (CGPoint(x: 20, y: 100), false, .rejected),
            // Content-card start on a presented drawer: closing must still work.
            (CGPoint(x: 300, y: 400), false, .rejected),
        ]
        for (startLocation, canOpenFromEdge, expected) in cases {
            #expect(Drawer.dragDisposition(
                startLocation: startLocation,
                translation: CGSize(width: 20, height: 0),
                isPresented: false,
                initialPresentation: false,
                canOpenFromEdge: canOpenFromEdge,
                latchedDisposition: nil) == expected)
            #expect(Drawer.dragDisposition(
                startLocation: startLocation,
                translation: CGSize(width: -20, height: 0),
                isPresented: true,
                initialPresentation: true,
                canOpenFromEdge: canOpenFromEdge,
                latchedDisposition: nil) == .closing)
        }
    }

    @Test(arguments: [false, true])
    func `vertical scrolling wins before a later horizontal thumb arc`(isPresented: Bool) {
        var disposition: Drawer.DragDisposition?
        for (translation, expected): (CGSize, Drawer.DragDisposition?) in [
            (CGSize(width: 8, height: 7), nil),
            (CGSize(width: 12, height: 20), .rejected),
            (CGSize(width: 60, height: 0), .rejected),
        ] {
            disposition = Drawer.dragDisposition(
                startLocation: CGPoint(x: 20, y: 100),
                translation: CGSize(
                    width: isPresented ? -translation.width : translation.width,
                    height: translation.height),
                isPresented: isPresented,
                initialPresentation: isPresented,
                canOpenFromEdge: true,
                latchedDisposition: disposition)
            #expect(disposition == expected)
        }
    }

    @Test(arguments: [false, true])
    func `committed drawer drags keep their direction`(isPresented: Bool) {
        var disposition: Drawer.DragDisposition?
        for translation in [CGSize(width: 20, height: 5), CGSize(width: 20, height: 40)] {
            disposition = Drawer.dragDisposition(
                startLocation: CGPoint(x: 20, y: 100),
                translation: CGSize(
                    width: isPresented ? -translation.width : translation.width,
                    height: translation.height),
                isPresented: isPresented,
                initialPresentation: isPresented,
                canOpenFromEdge: true,
                latchedDisposition: disposition)
            #expect(disposition == (isPresented ? .closing : .opening))
        }
    }
}
