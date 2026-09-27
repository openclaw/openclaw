import Observation
import OpenClawKit
import SwiftUI
import UIKit
import XCTest
@testable import OpenClaw

@MainActor
@Observable
private final class ChatTypingRenderPhase {
    var value = 0
}

@MainActor
private final class ChatTypingRenderCompletion {
    private var completedPhase = -1
    private var awaitedPhase: Int?
    private var continuation: CheckedContinuation<Void, Never>?

    func complete(_ phase: Int) {
        self.completedPhase = max(self.completedPhase, phase)
        guard let awaitedPhase, self.completedPhase >= awaitedPhase else { return }
        self.awaitedPhase = nil
        let continuation = self.continuation
        self.continuation = nil
        continuation?.resume()
    }

    func wait(for phase: Int) async {
        if self.completedPhase >= phase { return }
        await withCheckedContinuation { continuation in
            self.awaitedPhase = phase
            self.continuation = continuation
        }
    }
}

private struct ChatTypingRenderBoundary: UIViewRepresentable {
    let phase: Int
    let completion: ChatTypingRenderCompletion

    func makeUIView(context: Context) -> UIView {
        UIView()
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // Observe the completed SwiftUI transaction without changing the real composer.
        DispatchQueue.main.async {
            uiView.window?.layoutIfNeeded()
            self.completion.complete(self.phase)
        }
    }
}

private struct ChatTypingRenderedOwner: View {
    let phase: ChatTypingRenderPhase
    let completion: ChatTypingRenderCompletion

    var body: some View {
        NavigationStack {
            ChatProTab(headerSidebarAction: nil, openSettings: {})
                .overlay(alignment: .topLeading) {
                    ChatTypingRenderBoundary(phase: self.phase.value, completion: self.completion)
                        .frame(width: 1, height: 1)
                        .allowsHitTesting(false)
                }
        }
    }
}

/// XCTest keeps awaited key-window checks outside Swift Testing's concurrent suites.
@MainActor
final class ChatTypingFocusTests: XCTestCase {
    func testInitialAgentHydrationPreservesFocusedTypingWithinAccount() async throws {
        for changesAccount in [true, false] {
            try await Self.checkTyping(changesAccount: changesAccount)
        }
    }

    private static func checkTyping(changesAccount: Bool) async throws {
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

        let phase = ChatTypingRenderPhase()
        let completion = ChatTypingRenderCompletion()
        let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let controller = UIHostingController(rootView: ChatTypingRenderedOwner(
            phase: phase,
            completion: completion)
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
        await completion.wait(for: 0)
        await Self.completeDeferredInteractionUpdate()

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
        // This test-owned phase observes a transaction even if the owner reuses its model.
        phase.value = 1
        await completion.wait(for: 1)
        await Self.completeDeferredInteractionUpdate()
        let currentModel = try XCTUnwrap(owner.viewModel)
        let currentEditor = try XCTUnwrap(Self.composer(in: controller.view))
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
    private static func completeDeferredInteractionUpdate() async {
        // ChatComposerTextViewIOS deliberately applies interactivity on the next main-queue turn.
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    @MainActor
    private static func composer(in view: UIView) -> UITextView? {
        if let editor = view as? UITextView, editor.accessibilityIdentifier == "chat-message-input" {
            return editor
        }
        for child in view.subviews {
            if let editor = Self.composer(in: child) { return editor }
        }
        return nil
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
