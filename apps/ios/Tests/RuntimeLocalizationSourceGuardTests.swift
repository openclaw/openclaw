import Foundation
import Testing
@testable import OpenClaw

struct RuntimeLocalizationSourceGuardTests {
    @Test func liveActivityStatePersistsSemanticsAndExternalDetail() throws {
        for status in OpenClawActivityAttributes.ContentState.Status.allCases {
            let state = OpenClawActivityAttributes.ContentState(
                status: status,
                verbatimDetail: status == .attention ? "Backend supplied detail" : nil,
                startedAt: Date(timeIntervalSince1970: 1_234))
            let data = try JSONEncoder().encode(state)
            let decoded = try JSONDecoder().decode(OpenClawActivityAttributes.ContentState.self, from: data)

            #expect(decoded == state)
        }
    }

    @Test func liveActivityStateDecodesShippedLegacyPayloads() throws {
        let cases: [(LegacyContentState, OpenClawActivityAttributes.ContentState.Status, String?)] = [
            (LegacyContentState(statusText: "Disconnected", isDisconnected: true), .disconnected, nil),
            (LegacyContentState(statusText: "Idle", isIdle: true), .idle, nil),
            (LegacyContentState(statusText: "Reconnecting...", isConnecting: true), .reconnecting, nil),
            (LegacyContentState(statusText: "Ansluter igen...", isConnecting: true), .reconnecting, nil),
            (LegacyContentState(statusText: "Approval needed"), .approvalNeeded, nil),
            (LegacyContentState(statusText: "Backend supplied attention"), .attention, "Backend supplied attention"),
            (
                LegacyContentState(statusText: "Backend supplied connection detail", isConnecting: true),
                .connecting,
                "Backend supplied connection detail"),
        ]

        for (legacy, expectedStatus, expectedDetail) in cases {
            let data = try JSONEncoder().encode(legacy)
            let decoded = try JSONDecoder().decode(OpenClawActivityAttributes.ContentState.self, from: data)

            #expect(decoded.status == expectedStatus)
            #expect(decoded.verbatimDetail == expectedDetail)
            #expect(decoded.startedAt == legacy.startedAt)
        }
    }

    @Test func runtimeOwnedCopyRemainsLocalizableAtRenderTime() throws {
        let attributes = try Self.source("Sources/LiveActivity/OpenClawActivityAttributes.swift")
        let manager = try Self.source("Sources/LiveActivity/LiveActivityManager.swift")
        let widget = try Self.source("ActivityWidget/OpenClawLiveActivity.swift")
        let project = try Self.source("project.yml")
        let dreaming = try Self.source("Sources/Design/AgentProDreamingDestination.swift")
        let watchInbox = try Self.source("WatchApp/Sources/WatchInboxView.swift")
        let chat = try Self.sharedSource("OpenClawChatUI/ChatMessageViews.swift")

        #expect(!attributes.contains("var statusText"))
        #expect(attributes.contains("var status: Status"))
        #expect(attributes.contains("var verbatimDetail: String?"))
        #expect(attributes.contains("private enum LegacyCodingKeys"))
        #expect(manager.contains("status: .disconnected"))
        #expect(!manager.contains("statusText: String(localized: \"Disconnected\")"))
        #expect(widget.contains("Text(verbatim: detail)"))
        #expect(widget.contains("case .reconnecting: Text(\"Reconnecting...\")"))
        #expect(project.contains("""
          OpenClawActivityWidget:
        """))
        #expect(project.contains("""
              - path: Resources/Localizable.xcstrings
                buildPhase: resources
        """))
        #expect(dreaming.contains("AttributedString(localized: \"^[\\(recallCount) recall](inflect: true)\""))
        #expect(dreaming.contains("format: String(localized: \"%@ grounded\")"))
        #expect(dreaming.contains("parts.formatted(.list(type: .and, width: .short))"))
        #expect(chat.contains("private var title: LocalizedStringResource"))
        #expect(chat.contains("private var accessibilityText: LocalizedStringResource"))
        #expect(chat.contains(".accessibilityLabel(Text(self.accessibilityText))"))
        #expect(watchInbox.contains("case localized(LocalizedStringResource)"))
        #expect(!watchInbox.contains("WatchTextValue: ExpressibleByStringLiteral"))
        #expect(watchInbox.contains("accessory: .verbatim(self.store.talkSummaryText)"))
    }

    private static func source(_ path: String) throws -> String {
        try String(
            contentsOf: Self.iosRoot.appendingPathComponent(path),
            encoding: .utf8)
    }

    private static func sharedSource(_ path: String) throws -> String {
        try String(
            contentsOf: Self.iosRoot
                .deletingLastPathComponent()
                .appendingPathComponent("shared/OpenClawKit/Sources")
                .appendingPathComponent(path),
            encoding: .utf8)
    }

    private static let iosRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    private struct LegacyContentState: Encodable {
        let statusText: String
        var isIdle = false
        var isDisconnected = false
        var isConnecting = false
        var startedAt = Date(timeIntervalSince1970: 1_234)
    }
}
