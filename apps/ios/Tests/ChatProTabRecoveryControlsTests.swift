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

/// A rendered control reports SwiftUI's `.disabled(_:)` either as a control state or as
/// the accessibility trait published for a disabled element. Toolbar content can also be
/// published as a `UIAccessibilityElement` a container owns instead of a `UIView`, so both
/// forms are searched and both report their own interactivity.
@MainActor
private struct ChatRecoveryRenderedControl {
    let view: UIView?
    let element: UIAccessibilityElement?

    init(view: UIView) {
        self.view = view
        self.element = nil
    }

    init(element: UIAccessibilityElement) {
        self.view = nil
        self.element = element
    }

    var identifier: String? {
        self.element?.accessibilityIdentifier ?? self.view?.accessibilityIdentifier
    }

    var label: String? {
        self.element?.accessibilityLabel ?? self.view?.accessibilityLabel
    }

    var isEnabled: Bool {
        if let element = self.element {
            return !element.accessibilityTraits.contains(.notEnabled)
        }
        guard let view = self.view else { return false }
        if let control = view as? UIControl {
            return control.isEnabled
        }
        if view.isAccessibilityElement {
            return !view.accessibilityTraits.contains(.notEnabled)
        }
        return !view.subviews.contains { !Self.isEnabled($0) }
    }

    /// Reaches the control whatever backs it: a `UIControl` touch event first, then the
    /// element's own accessibility activation, then an accessible descendant's. A control
    /// that cannot be activated fails the regression instead of silently skipping it.
    func activate() -> Bool {
        if let element = self.element {
            return element.accessibilityActivate()
        }
        guard let view = self.view else { return false }
        if let control = Self.firstControl(in: view) {
            control.sendActions(for: .touchUpInside)
            return true
        }
        if view.isAccessibilityElement, view.accessibilityActivate() { return true }
        if let accessible = Self.firstAccessible(in: view), accessible.accessibilityActivate() {
            return true
        }
        return false
    }

    var describe: String {
        let kind = self.element.map { "element(\(type(of: $0)))" }
            ?? self.view.map { "view(\(type(of: $0)))" } ?? "unknown"
        return "\(kind) id=\(self.identifier ?? "-") label=\(self.label ?? "-") enabled=\(self.isEnabled)"
    }

    static func isEnabled(_ view: UIView) -> Bool {
        Self(view: view).isEnabled
    }

    private static func firstControl(in view: UIView) -> UIControl? {
        if let control = view as? UIControl { return control }
        for subview in view.subviews {
            if let control = self.firstControl(in: subview) { return control }
        }
        return nil
    }

    private static func firstAccessible(in view: UIView) -> UIView? {
        for subview in view.subviews {
            if subview.isAccessibilityElement { return subview }
            if let nested = self.firstAccessible(in: subview) { return nested }
        }
        return nil
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

        let statusButton = try await self.requireRecoveryControlsReachable(in: window)

        // An unhealthy gateway routes the status button to Gateway settings: that is the
        // recovery the reporter could not reach. Activate it whatever backs the identifier,
        // then require the route to have run — a conditional activation would let the
        // recovery path disappear without failing the regression.
        XCTAssertTrue(
            statusButton.activate(),
            "The unhealthy status button must accept a native activation while the reconnect retries.")
        XCTAssertTrue(
            probe.openedSettings,
            "Tapping the unhealthy status button must open Gateway settings during reconnect.")
        self.attachRenderedEvidence(
            named: "recovery-gateway-settings-route-executed",
            window: window,
            states: [("opened-settings", probe.openedSettings)])

        // The chat surface keeps its lock: the composer belongs to the captured owner
        // until the pending handoff settles. Required rather than optional, so the
        // protection is asserted on every run.
        let renderedComposer = await Self.renderedComposer(in: hosting.view)
        let composer = try XCTUnwrap(
            renderedComposer,
            "The chat surface must render its composer while the gateway retries.")
        XCTAssertTrue(composer.window === window, "The locked composer must be onscreen.")
        XCTAssertFalse(
            composer.isEditable,
            "Chat mutations must still wait for the pending gateway handoff.")
        XCTAssertFalse(
            composer.isSelectable,
            "A composer waiting for the pending gateway owner must not accept selection either.")
        XCTAssertTrue(composer.accessibilityTraits.contains(.notEnabled))
        XCTAssertFalse(composer.isFirstResponder)
        self.attachRenderedEvidence(
            named: "recovery-composer-locked",
            window: window,
            states: [
                ("composer-editable", composer.isEditable),
                ("composer-selectable", composer.isSelectable),
                ("composer-not-enabled-trait", composer.accessibilityTraits.contains(.notEnabled)),
            ])
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

    /// Rendered evidence for the recovery path: the screen exactly as the assertions saw it, plus
    /// the interactivity each control published. Kept in the result bundle so an Apple lane run
    /// carries the media and the diagnostics instead of only a pass/fail line.
    private func attachRenderedEvidence(named name: String, window: UIWindow, states: [(String, Bool)]) {
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let screenshot = XCTAttachment(image: renderer.image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        screenshot.name = "\(name)-screen"
        screenshot.lifetime = .keepAlways
        self.add(screenshot)

        let diagnostics = states
            .map { entry in "\(entry.0): \(entry.1 ? "enabled" : "disabled")" }
            .joined(separator: "\n")
        let controlStates = XCTAttachment(string: "\(name)\n\(diagnostics)")
        controlStates.name = "\(name)-control-states"
        controlStates.lifetime = .keepAlways
        self.add(controlStates)
    }

    /// The composer applies its interactivity on a deferred main-queue turn, so the walk retries
    /// until the editor exists. Bounded on purpose: a wait without a deadline would hang the suite
    /// instead of failing it when the chat surface never renders its composer.
    private static func renderedComposer(in view: UIView) async -> UITextView? {
        let deadline = Date(timeIntervalSinceNow: 10)
        while Date() < deadline {
            view.setNeedsLayout()
            view.layoutIfNeeded()
            if let composer = self.composer(in: view) { return composer }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return self.composer(in: view)
    }

    /// Requires the three routes to Gateway settings to be rendered and reachable while the
    /// automatic reconnect keeps retrying, and returns the unhealthy status button so the caller
    /// can drive the recovery route itself.
    private func requireRecoveryControlsReachable(in window: UIWindow) async throws
        -> ChatRecoveryRenderedControl
    {
        let renderedSidebarToggle = await Self.renderedControl(
            withIdentifier: "chat-recovery-sidebar-toggle",
            in: window)
        let sidebarToggle = try XCTUnwrap(
            renderedSidebarToggle,
            Self.missingControlMessage(
                "The sidebar toggle must be rendered while the gateway retries.",
                in: window))
        XCTAssertTrue(
            sidebarToggle.isEnabled,
            "The sidebar must stay reachable so the saved gateway can be managed.")
        let renderedStatusButton = await Self.renderedControl(
            withIdentifier: "chat-agent-identity",
            in: window)
        let statusButton = try XCTUnwrap(
            renderedStatusButton,
            Self.missingControlMessage(
                "The gateway status button must be rendered while the gateway retries.",
                in: window))
        XCTAssertTrue(
            statusButton.isEnabled,
            "The unhealthy status button advertises 'Opens Settings / Gateway' and must stay tappable.")
        let renderedChatActions = await Self.renderedControl(withLabel: "Chat actions", in: window)
        let chatActions = try XCTUnwrap(
            renderedChatActions,
            Self.missingControlMessage(
                "The Chat actions toolbar button must be rendered while the gateway retries.",
                in: window))
        XCTAssertTrue(
            chatActions.isEnabled,
            "Chat actions carries the in-product Gateway settings route and must stay tappable.")
        let inventory = XCTAttachment(string: Self.renderedInventory(in: window))
        inventory.name = "recovery-rendered-inventory"
        inventory.lifetime = .keepAlways
        self.add(inventory)
        self.attachRenderedEvidence(
            named: "recovery-toolbar-reachable-while-retrying",
            window: window,
            states: [
                ("sidebar-toggle", sidebarToggle.isEnabled),
                ("gateway-status-button", statusButton.isEnabled),
                ("chat-actions", chatActions.isEnabled),
            ])
        return statusButton
    }

    /// Every rendered control in the window this regression mounted, walking the view tree and
    /// the accessibility elements a container publishes: SwiftUI can hand a toolbar button out
    /// as an element instead of a `UIView`, and a view-only walk misses it. Scoped to this
    /// window on purpose — the host app renders a chat toolbar of its own, and matching that one
    /// would measure the wrong controls.
    private static func renderedControls(in root: UIView) -> [ChatRecoveryRenderedControl] {
        var found: [ChatRecoveryRenderedControl] = []
        var stack: [UIView] = [root]
        while let view = stack.popLast() {
            found.append(ChatRecoveryRenderedControl(view: view))
            stack.append(contentsOf: view.subviews)
            for case let element as UIAccessibilityElement in view.accessibilityElements ?? [] {
                found.append(ChatRecoveryRenderedControl(element: element))
            }
        }
        return found
    }

    /// Bounded on purpose, like the composer walk below: a control that never appears must fail
    /// the regression instead of hanging the suite until the lane's execution allowance kills it.
    private static func waitForRenderedControl(
        in window: UIView,
        deadline: TimeInterval = 10,
        matching matches: (ChatRecoveryRenderedControl) -> Bool) async
        -> ChatRecoveryRenderedControl?
    {
        let limit = Date(timeIntervalSinceNow: deadline)
        while true {
            window.setNeedsLayout()
            window.layoutIfNeeded()
            if let match = self.renderedControls(in: window).first(where: matches) { return match }
            if Date() >= limit { return nil }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private static func renderedControl(withIdentifier identifier: String, in window: UIView) async
        -> ChatRecoveryRenderedControl?
    {
        await self.waitForRenderedControl(in: window) { $0.identifier == identifier }
    }

    private static func renderedControl(withLabel label: String, in window: UIView) async
        -> ChatRecoveryRenderedControl?
    {
        await self.waitForRenderedControl(in: window) { $0.label == label }
    }

    /// Failure message for a control the renderer did not publish: it carries the inventory of
    /// what the window does contain, so a miss names the real hierarchy instead of only the
    /// expectation. Evaluated through XCTUnwrap's autoclosure, so only on failure.
    private static func missingControlMessage(_ expectation: String, in window: UIView) -> String {
        "\(expectation)\nRendered controls:\n\(self.renderedInventory(in: window))"
    }

    /// Doubles as the failure message: when a control is missing, the run reports what the
    /// renderer did publish instead of only what was expected.
    private static func renderedInventory(in window: UIView) -> String {
        self.renderedControls(in: window)
            .filter { $0.identifier != nil || $0.label != nil }
            .prefix(300)
            .map(\.describe)
            .joined(separator: "\n")
    }

    private static func composer(in view: UIView) -> UITextView? {
        if let editor = view as? UITextView, editor.accessibilityIdentifier == "chat-message-input" {
            return editor
        }
        return view.subviews.compactMap { Self.composer(in: $0) }.first
    }
}
