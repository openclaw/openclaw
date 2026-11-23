import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct SidebarDrawerGesturePolicyTests {
    typealias Policy = SidebarDrawerGesturePolicy

    private static func policy(
        layoutMode: RootTabs.SidebarLayoutMode = .drawer,
        isPresented: Bool = false,
        openingRegion: Policy.OpeningRegion = .edge,
        reduceMotion: Bool = false) -> Policy
    {
        Policy(
            layoutMode: layoutMode,
            isPresented: isPresented,
            openingRegion: openingRegion,
            reduceMotion: reduceMotion)
    }

    @Test func `only an eligible drawer enables each recognizer`() {
        #expect(Self.policy().isEnabled(for: .open))
        #expect(!Self.policy().isEnabled(for: .close))
        #expect(Self.policy(isPresented: true).isEnabled(for: .close))
        #expect(!Self.policy(isPresented: true).isEnabled(for: .open))
        // Pushed content owns the edge (interactive pop), so the open pan is off entirely.
        #expect(!Self.policy(openingRegion: .disabled).isEnabled(for: .open))
        for intent in [Policy.Intent.open, .close] {
            for isPresented in [false, true] {
                // Split mode keeps its padding layout and has no drawer gesture.
                #expect(!Self.policy(layoutMode: .split, isPresented: isPresented).isEnabled(for: intent))
                #expect(!Self.policy(isPresented: isPresented, reduceMotion: true).isEnabled(for: intent))
            }
        }
    }

    @Test(arguments: [Policy.OpeningRegion.edge, .content])
    func `root chat also opens from the conversation below the header`(region: Policy.OpeningRegion) {
        let policy = Self.policy(openingRegion: region)
        let rightward = CGSize(width: 12, height: 3)
        #expect(policy.intent(start: CGPoint(x: 4, y: 300), translation: rightward) == .open)
        #expect(policy.intent(start: CGPoint(x: 200, y: 400), translation: rightward) ==
            (region == .content ? .open : nil))
        #expect(policy.intent(start: CGPoint(x: 20, y: 30), translation: rightward) == nil)
    }

    @Test func `drawer space measures from the leading screen edge and the safe area top`() {
        let point = CGPoint(x: 10, y: 120)
        #expect(SidebarDrawerPanRecognizer.drawerPoint(
            point, windowWidth: 390, safeAreaTop: 59, isRightToLeft: false) == CGPoint(x: 10, y: 61))
        #expect(SidebarDrawerPanRecognizer.drawerPoint(
            CGPoint(x: 386, y: 120), windowWidth: 390, safeAreaTop: 59, isRightToLeft: true) == CGPoint(x: 4, y: 61))
    }

    @Test func `an edge pan must move mostly toward the trailing edge`() {
        let start = CGPoint(x: 4, y: 400)
        // The harness drag: 0.8 of the width with 40 pt of vertical drift.
        #expect(Self.policy().intent(start: start, translation: CGSize(width: 310, height: 40)) == .open)
        #expect(Self.policy().intent(start: start, translation: CGSize(width: 11, height: -10)) == .open)
        #expect(Self.policy().intent(start: start, translation: CGSize(width: 10, height: 10)) == nil)
        #expect(Self.policy().intent(start: start, translation: CGSize(width: 6, height: -14)) == nil)
        #expect(Self.policy().intent(start: start, translation: CGSize(width: -10, height: 0)) == nil)
    }

    @Test func `closing accepts a leftward pan anywhere over the presented drawer`() {
        let presented = Self.policy(isPresented: true)
        for start in [CGPoint(x: 300, y: 400), CGPoint(x: 20, y: 20), CGPoint(x: 600, y: 900)] {
            #expect(presented.intent(start: start, translation: CGSize(width: -12, height: 4)) == .close)
            #expect(presented.intent(start: start, translation: CGSize(width: 12, height: 0)) == nil)
            #expect(presented.intent(start: start, translation: CGSize(width: -8, height: 9)) == nil)
        }
        #expect(Self.policy(isPresented: true, openingRegion: .disabled)
            .intent(start: CGPoint(x: 300, y: 400), translation: CGSize(width: -12, height: 0)) == .close)
    }

    @Test func `tracking follows the finger within the sidebar width`() {
        #expect(Policy.trackingOffset(for: .open, translation: 120, sidebarWidth: 316) == 120)
        #expect(Policy.trackingOffset(for: .open, translation: 500, sidebarWidth: 316) == 316)
        #expect(Policy.trackingOffset(for: .open, translation: -30, sidebarWidth: 316) == 0)
        #expect(Policy.trackingOffset(for: .close, translation: -120, sidebarWidth: 316) == -120)
        #expect(Policy.trackingOffset(for: .close, translation: -500, sidebarWidth: 316) == -316)
        #expect(Policy.trackingOffset(for: .close, translation: 30, sidebarWidth: 316) == 0)
    }

    @Test(arguments: [Policy.Intent.open, .close])
    func `release settles by distance and projected velocity`(intent: Policy.Intent) {
        let committed: Policy.Action = intent == .open ? .open : .close
        let direction: CGFloat = intent == .open ? 1 : -1
        let cases: [(CGFloat, CGFloat, Policy.Action)] = [
            (60, 0, .ignore),
            (81, 0, committed),
            // A short flick carries past the threshold.
            (20, 400, committed),
            // A long drag flicked back toward the start cancels.
            (120, -400, .ignore),
            (0, 0, .ignore),
        ]
        for (distance, speed, expected) in cases {
            #expect(Policy.action(
                for: intent,
                translation: direction * distance,
                velocity: direction * speed) == expected)
        }
    }

    @Test func `scroll view pans wait for the drawer pan to fail`() {
        typealias Coordinator = SidebarDrawerPanGesture.Coordinator
        let collection = UICollectionView(frame: .zero, collectionViewLayout: UICollectionViewFlowLayout())
        let scroll = UIScrollView()
        #expect(Coordinator.mustWaitForDrawer(collection.panGestureRecognizer))
        #expect(Coordinator.mustWaitForDrawer(scroll.panGestureRecognizer))

        let tap = UITapGestureRecognizer()
        scroll.addGestureRecognizer(tap)
        #expect(!Coordinator.mustWaitForDrawer(tap))
        let plainPan = UIPanGestureRecognizer()
        UIView().addGestureRecognizer(plainPan)
        #expect(!Coordinator.mustWaitForDrawer(plainPan))
        #expect(!Coordinator.mustWaitForDrawer(UIPanGestureRecognizer()))
    }

    @Test func `drawer toggles leave the chat tab equal`() {
        func header(_ identifier: String) -> OpenClawSidebarHeaderAction {
            OpenClawSidebarHeaderAction(
                systemName: "line.3.horizontal",
                accessibilityLabel: .localized("Show Sidebar"),
                accessibilityIdentifier: identifier,
                action: {})
        }
        let show = RootTabs.sidebarShowButtonAccessibilityIdentifier
        let hide = RootTabs.sidebarHideButtonAccessibilityIdentifier
        let showTab = ChatProTab(headerSidebarAction: header(show), startFirstGatewaySetup: nil)
        #expect(showTab == ChatProTab(headerSidebarAction: header(show), startFirstGatewaySetup: nil))
        #expect(showTab != ChatProTab(headerSidebarAction: header(hide), startFirstGatewaySetup: nil))
        let firstRunTab = ChatProTab(headerSidebarAction: header(show), startFirstGatewaySetup: {})
        #expect(showTab != firstRunTab)
        #expect(firstRunTab == ChatProTab(
            headerSidebarAction: header(show),
            startFirstGatewaySetup: {}))
    }
}
