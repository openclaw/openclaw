import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct QuickChatViewSmokeTests {
    @Test func `quick chat view builds body`() {
        let model = QuickChatModel(
            sessionKeyProvider: { "main" },
            agentIdentityProvider: { _ in QuickChatAgentDisplay(name: "Agent", emoji: nil) },
            sendProvider: { _, _, _ in "ok" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available })
        let view = QuickChatView(
            model: model,
            onDismiss: {},
            onSendAccepted: { _ in },
            onContentHeightChange: { _ in },
            onTextViewReady: { _ in })

        _ = view.body
    }
}
