import Foundation
import OpenClawKit
import SwiftUI
import UIKit
import XCTest
@testable import OpenClaw

@MainActor
private final class ChatRecoveryProbe {
    var openedSettings = false
}

private struct ChatRecoveryRenderedOwner: View {
    let sidebarAction: OpenClawSidebarHeaderAction
    let openSettings: () -> Void

    var body: some View {
        NavigationStack {
            ChatProTab(headerSidebarAction: self.sidebarAction, openSettings: self.openSettings)
        }
    }
}

/// XCTest keeps key-window checks outside Swift Testing's concurrent suites.
@MainActor
final class ChatProTabRecoveryControlsTests: XCTestCase {
    /// #191449: a saved endpoint that stopped answering keeps automatic preflight
    /// retrying, so the connection handoff stays pending for as long as the app runs.
    /// Chat mutations must keep waiting for that handoff while every route to Gateway
    /// settings stays reachable.
    func testRecoveryControlsStayReachableWhileAutomaticPreflightRetries() async throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive },
            "The recovery test requires an active app scene.")
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let instanceID = "chat-recovery-\(UUID().uuidString)"
        let state = try TemporaryOpenClawState(instanceID: instanceID)
        defer { state.restore() }
        let previousAutoConnect = UserDefaults.standard.object(forKey: "gateway.autoconnect")
        defer { UserDefaults.standard.set(previousAutoConnect, forKey: "gateway.autoconnect") }

        let fixture = try IngressTestHarness()
        let savedEntry = try XCTUnwrap(fixture.profileRows.first)
        XCTAssertTrue(GatewaySettingsStore.upsertGatewayRegistryEntry(savedEntry, activate: true))
        XCTAssertTrue(GatewaySettingsStore.saveGatewayCredentials(
            token: "gateway-token",
            bootstrapToken: nil,
            password: nil,
            gatewayStableID: fixture.stableID,
            suppressStoredDeviceAuth: false,
            instanceId: instanceID))
        let previousPin = GatewayTLSStore.loadFingerprint(stableID: fixture.stableID)
        GatewayTLSStore.saveFingerprint(String(repeating: "ab", count: 32), stableID: fixture.stableID)
        defer {
            _ = GatewayTLSStore.clearFingerprint(stableID: fixture.stableID)
            if let previousPin {
                GatewayTLSStore.saveFingerprint(previousPin, stableID: fixture.stableID)
            }
        }

        // The saved WSS endpoint never answers, the way a DHCP-changed LAN host does not.
        fixture.probeFailure = URLError(.notConnectedToInternet)
        fixture.preauthenticated = true
        let ingress = fixture.controller(useSavedProfiles: true)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let retryGate = IngressTestGate()
        defer { retryGate.release() }
        UserDefaults.standard.set(true, forKey: "gateway.autoconnect")
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            autoConnectRetryDelay: { _ in await retryGate.wait() },
            ingress: ingress,
            now: { fixture.now })

        // The gate is entered only from inside the injected retry delay, so its own start signal
        // proves the failing probe reached the retry boundary; `hasPendingConnectionHandoff` turns
        // true synchronously, before the probe runs, and would prove nothing on its own. This is
        // the same signal the other ingress suites await, and `defer { retryGate.release() }`
        // unwinds it. Read with a deadline for the same reason the composer walk below has one:
        // a fixture that never reaches the boundary must fail the regression instead of hanging
        // the suite until the lane's execution allowance kills it.
        let retryDeadline = Date(timeIntervalSinceNow: 30)
        while !retryGate.started, Date() < retryDeadline {
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(
            retryGate.started,
            "Automatic preflight must reach its retry boundary while the saved endpoint stays unreachable.")
        XCTAssertTrue(
            controller.hasPendingConnectionHandoff,
            "Automatic preflight must keep its handoff pending while the endpoint stays unreachable.")
        XCTAssertNil(appModel.activeGatewayConnectConfig)

        // RootTabs owns this sync in the app. The regression hosts ChatProTab directly, so it has
        // to establish the same presentation owner: without a view model the chat surface renders
        // its "Preparing Chat" placeholder and the composer the lock protects never exists.
        appModel.chatPresentation.sync(appModel: appModel)
        let chatViewModel = try XCTUnwrap(
            appModel.chatPresentation.viewModel,
            "The regression must render the real chat presentation owner, not its placeholder.")
        defer { chatViewModel.detachTransport() }

        let probe = ChatRecoveryProbe()
        let sidebarAction = OpenClawSidebarHeaderAction(
            systemName: "line.3.horizontal",
            accessibilityLabel: .localized("Show Sidebar"),
            accessibilityIdentifier: "chat-recovery-sidebar-toggle",
            action: {})
        let hosting = UIHostingController(rootView: ChatRecoveryRenderedOwner(
            sidebarAction: sidebarAction,
            openSettings: { probe.openedSettings = true })
            .environment(AppAppearanceModel())
            .environment(appModel)
            .environment(appModel.voiceWake)
            .environment(controller))
        let window = UIWindow(windowScene: scene)
        window.frame = scene.screen.bounds
        window.rootViewController = hosting
        window.makeKeyAndVisible()
        defer {
            window.endEditing(true)
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        hosting.view.setNeedsLayout()
        hosting.view.layoutIfNeeded()

        // What a real iOS 26.5 simulator rendering publishes for this fixture, and what the fix
        // has to keep: the toolbar renders its three bar items — the sidebar toggle, the gateway
        // status button and Chat actions — and every one of them stays interactive and undimmed
        // while the chat surface keeps waiting for the pending gateway owner. With main's
        // screen-wide lock the renderer flips `isUserInteractionEnabled` off on all three bar
        // items and dims their content to half alpha, which is the dead screen #191449 reports.
        let rendered = await Self.renderedScreen(in: window)
        let routesMessage = "ChatProTab's toolbar must render its three recovery routes "
            + "while the gateway retries." + rendered.inventory
        XCTAssertEqual(rendered.toolbarItems.count, 3, routesMessage)
        for (index, item) in rendered.toolbarItems.enumerated() {
            let tappableMessage = "Toolbar item \(index) must stay tappable while the automatic "
                + "reconnect retries." + rendered.inventory
            XCTAssertTrue(item.isUserInteractionEnabled, tappableMessage)
            let dimmedMessage = "Toolbar item \(index) must not render dimmed while the automatic "
                + "reconnect retries." + rendered.inventory
            XCTAssertFalse(Self.rendersDimmed(item), dimmedMessage)
        }
        let lockedMessage = "Chat mutations must still wait for the pending gateway handoff."
            + rendered.inventory
        XCTAssertFalse(rendered.lockedChatControls.isEmpty, lockedMessage)
        let composerMessage = "The locked chat surface must render its composer onscreen."
            + rendered.inventory
        XCTAssertTrue(rendered.composer?.window === window, composerMessage)
        self.attachRenderedEvidence(
            named: "recovery-toolbar-live-while-chat-locked",
            window: window,
            rendered: rendered)
    }

    func testChatMutationLockCoversEveryPendingGatewayOwner() {
        XCTAssertFalse(ChatProTab.chatMutationLock(
            isGatewayPickerRequestInFlight: false,
            hasPendingConnectionHandoff: false,
            isAttachmentOwnerPinned: false,
            capturedOwnerID: "owner-a",
            currentOwnerID: "owner-a"))

        XCTAssertTrue(ChatProTab.chatMutationLock(
            isGatewayPickerRequestInFlight: true,
            hasPendingConnectionHandoff: false,
            isAttachmentOwnerPinned: false,
            capturedOwnerID: "owner-a",
            currentOwnerID: "owner-a"))

        // The reported path: automatic preflight retries keep the handoff pending.
        XCTAssertTrue(ChatProTab.chatMutationLock(
            isGatewayPickerRequestInFlight: false,
            hasPendingConnectionHandoff: true,
            isAttachmentOwnerPinned: false,
            capturedOwnerID: "owner-a",
            currentOwnerID: "owner-a"))

        XCTAssertTrue(ChatProTab.chatMutationLock(
            isGatewayPickerRequestInFlight: false,
            hasPendingConnectionHandoff: false,
            isAttachmentOwnerPinned: false,
            capturedOwnerID: "owner-a",
            currentOwnerID: "owner-b"))

        // A deliberately pinned attachment owner keeps its existing controls.
        XCTAssertFalse(ChatProTab.chatMutationLock(
            isGatewayPickerRequestInFlight: false,
            hasPendingConnectionHandoff: false,
            isAttachmentOwnerPinned: true,
            capturedOwnerID: "owner-a",
            currentOwnerID: "owner-b"))
    }

    /// One rendering pass, read back out of the window the regression mounted: the toolbar's bar
    /// items, the chat controls the lock disabled, the composer, and the inventory every failure
    /// message and attachment carries.
    private struct RenderedScreen {
        let toolbarItems: [UIView]
        let lockedChatControls: [UIControl]
        let composer: UITextView?
        let inventory: String
    }

    /// Bounded on purpose: a renderer that never publishes the toolbar must fail the regression
    /// instead of hanging the suite until the lane's execution allowance kills it.
    private static func renderedScreen(
        in window: UIWindow,
        deadline: TimeInterval = 10) async -> RenderedScreen
    {
        let limit = Date(timeIntervalSinceNow: deadline)
        while true {
            window.setNeedsLayout()
            window.layoutIfNeeded()
            let views = self.views(in: window)
            let toolbarItems = views.filter { self.isBarItemHost($0) }
            let screen = RenderedScreen(
                toolbarItems: toolbarItems,
                lockedChatControls: views.compactMap { $0 as? UIControl }.filter { control in
                    !control.isEnabled && !toolbarItems.contains { control.isDescendant(of: $0) }
                },
                composer: views.first { $0.accessibilityIdentifier == "chat-message-input" } as? UITextView,
                inventory: "\nRendered controls:\n" + self.inventory(of: views))
            if !toolbarItems.isEmpty || Date() >= limit { return screen }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private static func views(in root: UIView) -> [UIView] {
        var found: [UIView] = []
        var stack: [UIView] = [root]
        var visited: Set<ObjectIdentifier> = []
        while let view = stack.popLast(), found.count < 5000 {
            guard visited.insert(ObjectIdentifier(view)).inserted else { continue }
            found.append(view)
            stack.append(contentsOf: view.subviews)
        }
        return found
    }

    /// The renderer's own host class for a SwiftUI toolbar item. It is not public API, so the
    /// count is asserted too: a rename or a restructured bar fails this regression with the
    /// rendered inventory instead of passing it vacuously.
    private static func isBarItemHost(_ view: UIView) -> Bool {
        String(describing: type(of: view)).contains("BarItemHost")
    }

    /// A SwiftUI control the environment disabled renders dimmed; with main's screen-wide lock
    /// every bar item's content drops to half alpha.
    private static func rendersDimmed(_ view: UIView) -> Bool {
        self.views(in: view).contains { $0.alpha < 0.9 }
    }

    /// Rendered evidence for the recovery path: the screen exactly as the assertions saw it, the
    /// states they read, and the full inventory. Kept in the result bundle so an Apple lane run
    /// carries the media and the diagnostics instead of only a pass/fail line.
    private func attachRenderedEvidence(
        named name: String,
        window: UIWindow,
        rendered: RenderedScreen)
    {
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let screenshot = XCTAttachment(image: renderer.image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        screenshot.name = "\(name)-screen"
        screenshot.lifetime = .keepAlways
        self.add(screenshot)

        let interactive = rendered.toolbarItems.filter(\.isUserInteractionEnabled).count
        let dimmed = rendered.toolbarItems.filter { Self.rendersDimmed($0) }.count
        let states = XCTAttachment(string: """
        \(name)
        toolbarItems: \(rendered.toolbarItems.count)
        toolbarInteractive: \(interactive)
        toolbarDimmed: \(dimmed)
        lockedChatControls: \(rendered.lockedChatControls.count)
        composerRendered: \(rendered.composer != nil)
        """)
        states.name = "\(name)-control-states"
        states.lifetime = .keepAlways
        self.add(states)

        let inventory = XCTAttachment(string: rendered.inventory)
        inventory.name = "\(name)-inventory"
        inventory.lifetime = .keepAlways
        self.add(inventory)
    }

    private static func inventory(of views: [UIView]) -> String {
        views.prefix(300).map { self.describe($0) }.joined(separator: "\n")
    }

    private static func describe(_ view: UIView) -> String {
        let control = (view as? UIControl).map { " controlEnabled=\($0.isEnabled)" } ?? ""
        return "view(\(type(of: view))) id=\(view.accessibilityIdentifier ?? "-") " +
            "label=\(view.accessibilityLabel ?? "-") frame=\(self.frame(of: view)) " +
            "hidden=\(view.isHidden) alpha=\(view.alpha) " +
            "interaction=\(view.isUserInteractionEnabled)" + control
    }

    private static func frame(of view: UIView) -> String {
        let box = view.frame
        return "\(Int(box.minX)),\(Int(box.minY)),\(Int(box.width))x\(Int(box.height))"
    }
}
