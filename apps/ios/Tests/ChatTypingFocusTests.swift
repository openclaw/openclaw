import Observation
import OpenClawChatUI
import OpenClawKit
import SwiftUI
import UIKit
import XCTest
@testable import OpenClaw

@MainActor
private enum ChatTypingMainRunLoop {
    /// Returns only when the main run loop idles at the test's own stack base with `isSettled` true.
    /// An awaited continuation can instead resume inside UIKit's nested keyboard run loop, mid-SwiftUI
    /// update, where a retired composer is still attached and cleared but not yet replaced.
    static func settle(until isSettled: @escaping @MainActor () -> Bool = { true }) {
        let settled = XCTestExpectation(description: "Main run loop settled at the test's stack base")
        settled.assertForOverFulfill = false
        var depth = 0
        let observer = CFRunLoopObserverCreateWithHandler(
            nil,
            CFRunLoopActivity([.entry, .beforeWaiting, .exit]).rawValue,
            true,
            CFIndex.max)
        { _, activity in
            switch activity {
            case .entry: depth += 1
            case .exit: depth -= 1
            default:
                // Depth 1 is the waiter's own loop; SwiftUI and Core Animation commit earlier in this callout.
                if depth == 1, MainActor.assumeIsolated(isSettled) { settled.fulfill() }
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        defer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 5), .completed)
    }
}

@MainActor
private final class ChatTypingKeyboardLoop {
    private(set) var didRun = false
    private(set) var isRunning = false

    func run(_ body: () -> Void) {
        self.didRun = true
        self.isRunning = true
        defer { self.isRunning = false }
        body()
        // Model UIKit's nested keyboard run loop: drain queued main work, including resumed main-actor jobs.
        for _ in 0..<8 {
            RunLoop.main.run(mode: .default, before: .distantPast)
        }
    }
}

@MainActor
private final class ChatTypingRenderProbe {
    private(set) var renderedPhase: Int?

    func record(_ phase: Int) {
        self.renderedPhase = phase
    }
}

private struct ChatTypingRenderBoundary: UIViewRepresentable {
    let phase: Int
    let probe: ChatTypingRenderProbe

    func makeUIView(context: Context) -> UIView {
        UIView()
    }

    func updateUIView(_: UIView, context: Context) {
        // Record only; tests read the phase after their own run loop settles.
        self.probe.record(self.phase)
    }
}

private struct ChatTypingRenderedOwner: View {
    var body: some View {
        NavigationStack {
            ChatProTab(headerSidebarAction: nil, openSettings: {})
        }
    }
}

@MainActor
@Observable
private final class ChatTypingReadinessState {
    var composerEnabled = false
    var ancestorDisabled = false

    var renderedState: Int {
        (self.composerEnabled ? 1 : 0) + (self.ancestorDisabled ? 2 : 0)
    }
}

private struct ChatTypingRenderedComposer: View {
    let viewModel: OpenClawChatViewModel
    let readiness: ChatTypingReadinessState
    let probe: ChatTypingRenderProbe

    var body: some View {
        NavigationStack {
            OpenClawChatView(
                viewModel: self.viewModel,
                composerChrome: .clean,
                isComposerEnabled: self.readiness.composerEnabled)
                .disabled(self.readiness.ancestorDisabled)
                .overlay(alignment: .topLeading) {
                    ChatTypingRenderBoundary(
                        phase: self.readiness.renderedState,
                        probe: self.probe)
                        .frame(width: 1, height: 1)
                        .allowsHitTesting(false)
                }
        }
    }
}

/// XCTest keeps key-window checks outside Swift Testing's concurrent suites.
@MainActor
final class ChatTypingFocusTests: XCTestCase {
    func testInitialAgentHydrationPreservesFocusedTypingWithinAccount() throws {
        for changesAccount in [true, false] {
            try Self.checkTyping(changesAccount: changesAccount)
        }
    }

    func testComposerDisabledReadinessAndRecovery() throws {
        try Self.checkComposerReadiness(disabledByAncestor: false)
    }

    func testAncestorDisabledComposerReadinessAndRecovery() throws {
        try Self.checkComposerReadiness(disabledByAncestor: true)
    }

    func testSettleWaitsAtStackBaseForReplacedEditor() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let retiredEditor = UITextView()
        window.addSubview(retiredEditor)
        let replacementEditor = UITextView()
        let keyboardLoop = ChatTypingKeyboardLoop()
        RunLoop.main.perform {
            MainActor.assumeIsolated {
                keyboardLoop.run {
                    retiredEditor.removeFromSuperview()
                    // The replacement lands on a later main-queue turn, as a deferred SwiftUI commit does.
                    DispatchQueue.main.async { window.addSubview(replacementEditor) }
                }
            }
        }

        ChatTypingMainRunLoop.settle { replacementEditor.window === window }

        XCTAssertTrue(keyboardLoop.didRun)
        XCTAssertFalse(keyboardLoop.isRunning, "The wait must return after the nested keyboard loop unwinds.")
        XCTAssertNil(retiredEditor.window)
        XCTAssertTrue(replacementEditor.window === window)
    }

    private static func checkComposerReadiness(disabledByAncestor: Bool) throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive },
            "The readiness test requires an active app scene.")
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let appModel = NodeAppModel()
        appModel.enterScreenshotFixtureMode()
        let owner = appModel.chatPresentation
        owner.sync(appModel: appModel)
        let model = try XCTUnwrap(owner.viewModel)
        defer { model.detachTransport() }
        model.input = ""

        let readiness = ChatTypingReadinessState()
        readiness.composerEnabled = disabledByAncestor
        readiness.ancestorDisabled = disabledByAncestor
        let probe = ChatTypingRenderProbe()
        let controller = UIHostingController(rootView: ChatTypingRenderedComposer(
            viewModel: model,
            readiness: readiness,
            probe: probe))
        let window = UIWindow(windowScene: scene)
        window.frame = scene.screen.bounds
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.endEditing(true)
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        Self.settleRender(probe, phase: readiness.renderedState)
        let editor = try XCTUnwrap(Self.composer(in: controller.view))
        XCTAssertTrue(window.isKeyWindow)
        XCTAssertTrue(editor.window === window)
        XCTAssertFalse(editor.isEditable)
        XCTAssertFalse(editor.isSelectable)
        XCTAssertTrue(editor.accessibilityTraits.contains(.notEnabled))
        XCTAssertFalse(editor.isFirstResponder)

        for suffix in ["draft", " resumed"] {
            if disabledByAncestor {
                readiness.ancestorDisabled = false
            } else {
                readiness.composerEnabled = true
            }
            Self.settleRender(probe, phase: readiness.renderedState)
            XCTAssertTrue(Self.composer(in: controller.view) === editor)
            XCTAssertTrue(editor.isEditable)
            XCTAssertTrue(editor.isSelectable)
            XCTAssertFalse(editor.accessibilityTraits.contains(.notEnabled))
            guard editor.becomeFirstResponder(), editor.isFirstResponder else {
                XCTFail("The enabled composer must acquire native keyboard focus.")
                return
            }
            let expectedDraft = model.input + suffix
            editor.insertText(suffix)
            XCTAssertEqual(model.input, expectedDraft)
            XCTAssertEqual(editor.text, expectedDraft)

            if disabledByAncestor {
                readiness.ancestorDisabled = true
            } else {
                readiness.composerEnabled = false
            }
            Self.settleRender(probe, phase: readiness.renderedState)
            XCTAssertTrue(Self.composer(in: controller.view) === editor)
            XCTAssertFalse(editor.isEditable)
            XCTAssertFalse(editor.isSelectable)
            XCTAssertTrue(editor.accessibilityTraits.contains(.notEnabled))
            XCTAssertFalse(editor.isFirstResponder)
            XCTAssertEqual(model.input, expectedDraft)
            XCTAssertEqual(editor.text, expectedDraft)
        }
    }

    private static func checkTyping(changesAccount: Bool) throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive },
            "The typing test requires an active app scene; an offscreen host cannot establish keyboard focus.")
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let appModel = NodeAppModel()
        appModel.enterScreenshotFixtureMode()
        appModel.gatewayDefaultAgentId = nil
        appModel.activeGatewayConnectConfig = try Self.gatewayConfig(token: "synthetic-first-account")
        let owner = appModel.chatPresentation
        defer { owner.viewModel?.detachTransport() }
        owner.sync(appModel: appModel)
        let originalModel = try XCTUnwrap(owner.viewModel)
        let gatewayOwner = appModel.chatViewModelOwnerID
        let sessionKey = appModel.chatSessionKey
        guard appModel.chatDeliveryAgentId == nil else {
            XCTFail("The fixture must begin before default-agent hydration.")
            return
        }

        let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let controller = UIHostingController(rootView: ChatTypingRenderedOwner()
            .environment(AppAppearanceModel())
            .environment(appModel)
            .environment(appModel.voiceWake)
            .environment(gatewayController))
        let window = UIWindow(windowScene: scene)
        window.frame = scene.screen.bounds
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.endEditing(true)
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        ChatTypingMainRunLoop.settle { Self.composer(in: controller.view) != nil }
        Self.completeDeferredInteractionUpdate()

        let originalEditor = try XCTUnwrap(Self.composer(in: controller.view))
        guard window.isKeyWindow, originalEditor.window === window else {
            XCTFail("The real composer must be onscreen.")
            return
        }
        guard originalEditor.isEditable, originalEditor.isSelectable else {
            XCTFail("The fixture composer must be enabled.")
            return
        }
        guard originalEditor.becomeFirstResponder(), originalEditor.isFirstResponder else {
            XCTFail("The fixture must acquire actual UIKit focus.")
            return
        }
        let draft = "Keep typing while the default agent resolves"
        originalEditor.insertText(draft)
        guard originalModel.input == draft else {
            XCTFail("UIKit input must reach the actual presentation model.")
            return
        }

        appModel.gatewayDefaultAgentId = "main"
        if changesAccount {
            appModel.activeGatewayConnectConfig = try Self.gatewayConfig(token: "synthetic-second-account")
        }
        guard appModel.chatViewModelOwnerID == gatewayOwner, appModel.chatSessionKey == sessionKey else {
            XCTFail("The fixture must preserve the gateway owner and session key during hydration.")
            return
        }
        owner.sync(appModel: appModel)
        // Deliver input before any render, layout, or main-queue continuation.
        if changesAccount {
            originalEditor.insertText("X")
            XCTAssertEqual(owner.viewModel?.input, "", "An old account's editor must not write into the new account.")
        } else {
            let handoffEditor = try XCTUnwrap(Self.composer(in: controller.view))
            guard handoffEditor.window === window, handoffEditor.isFirstResponder else {
                XCTFail("Same-account hydration must preserve focused input before rendering.")
                return
            }
            handoffEditor.insertText("X")
            XCTAssertEqual(handoffEditor.text, draft + "X")
        }
        if originalModel !== owner.viewModel {
            XCTAssertEqual(originalModel.input, draft, "Typing must not update the retired model.")
        }
        // Wait for the committed swap: an account change replaces the editor, hydration keeps it.
        ChatTypingMainRunLoop.settle {
            let editors = Self.composers(in: controller.view)
            return editors.count == 1 && (editors[0] === originalEditor) != changesAccount
        }
        Self.completeDeferredInteractionUpdate()
        let currentModel = try XCTUnwrap(owner.viewModel)
        let currentEditor = try XCTUnwrap(Self.composer(in: controller.view))
        XCTAssertEqual(currentEditor === originalEditor, !changesAccount)
        guard window.isKeyWindow, currentEditor.window === window else {
            XCTFail("The committed composer must remain onscreen in the active window.")
            return
        }
        let committedDraft = changesAccount ? "" : draft + "X"
        XCTAssertEqual(appModel.chatDeliveryAgentId, "main")
        XCTAssertEqual(currentModel.input, committedDraft)
        XCTAssertEqual(currentEditor.text, committedDraft)
        XCTAssertTrue(currentEditor.isEditable && currentEditor.isSelectable)
        if changesAccount {
            guard currentEditor.becomeFirstResponder(), currentEditor.isFirstResponder else {
                XCTFail("The new account must accept its own fresh input.")
                return
            }
        } else {
            XCTAssertTrue(
                currentEditor.isFirstResponder,
                "Same-account hydration must not interrupt an active typing session.")
        }
        if currentEditor.isFirstResponder {
            let retiredInput = originalModel.input
            currentEditor.insertText("Y")
            XCTAssertEqual(currentModel.input, committedDraft + "Y")
            XCTAssertEqual(currentEditor.text, committedDraft + "Y")
            if originalModel !== currentModel {
                XCTAssertEqual(
                    originalModel.input,
                    retiredInput,
                    "Typing must not update a retired presentation model.")
            }
        }
    }

    @MainActor
    private static func settleRender(_ probe: ChatTypingRenderProbe, phase: Int) {
        ChatTypingMainRunLoop.settle { probe.renderedPhase == phase }
        self.completeDeferredInteractionUpdate()
    }

    @MainActor
    private static func completeDeferredInteractionUpdate() {
        // ChatComposerTextViewIOS deliberately applies interactivity on the next main-queue turn.
        let applied = XCTestExpectation(description: "Deferred composer interaction update")
        DispatchQueue.main.async { applied.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [applied], timeout: 5), .completed)
    }

    @MainActor
    private static func composer(in view: UIView) -> UITextView? {
        self.composers(in: view).first
    }

    @MainActor
    private static func composers(in view: UIView) -> [UITextView] {
        if let editor = view as? UITextView, editor.accessibilityIdentifier == "chat-message-input" {
            return [editor]
        }
        return view.subviews.flatMap { Self.composers(in: $0) }
    }

    private static func gatewayConfig(token: String) throws -> GatewayConnectConfig {
        try GatewayConnectConfig(
            url: XCTUnwrap(URL(string: "wss://typing-focus.example.test")),
            stableID: "typing-focus-fixture",
            tls: nil,
            token: token,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone"))
    }
}
