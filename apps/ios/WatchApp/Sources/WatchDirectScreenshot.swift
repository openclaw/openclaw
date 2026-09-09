#if DEBUG && targetEnvironment(simulator)
import Foundation
import OpenClawProtocol
import SwiftUI

enum WatchDirectScreenshot: String, Identifiable {
    case payment
    case paymentTerms = "payment-terms"
    case standingGrant = "standing-grant"
    case standingGrantTerms = "standing-grant-terms"
    case unsupportedContext = "unsupported-context"
    case creationFailed = "creation-failed"
    case creationUnknown = "creation-unknown"
    case creationSucceeded = "creation-succeeded"
    case noConversation = "no-conversation"

    var id: String {
        self.rawValue
    }

    static var current: Self? {
        let prefix = "--openclaw-watch-direct-proof="
        return ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(prefix) })
            .flatMap { Self(rawValue: String($0.dropFirst(prefix.count))) }
    }

    var status: String {
        switch self {
        case .creationUnknown:
            "Delivery uncertain. Check the original conversation before sending again."
        case .creationSucceeded:
            "Conversation created"
        default:
            "Conversation could not be created. Try again after reconnecting."
        }
    }

    var approval: WatchDirectApproval? {
        let scope: ApprovalScope
        switch self {
        case .payment, .paymentTerms:
            scope = .payment(PaymentApprovalScope(
                kind: "payment", amount: "149.95", currency: "USD", target: "Example Supplier"))
        case .standingGrant, .standingGrantTerms:
            scope = .standingGrant(StandingGrantApprovalScope(
                kind: "standing-grant", automation: "Daily report", command: "report --publish", expiresindays: 7))
        case .unsupportedContext:
            scope = .externalPost(ExternalPostApprovalScope(
                kind: "external-post", target: "Example feed", visibility: AnyCodable("future-visibility")))
        default:
            return nil
        }
        return WatchDirectApproval(snapshot: .pending(PendingApprovalSnapshot(
            id: "visual-review",
            urlpath: "/approval/visual-review",
            createdatms: 0,
            expiresatms: Int.max,
            presentation: .plugin(PluginApprovalPresentation(
                kind: "plugin",
                title: "Review request",
                description: "Confirm the terms below.",
                severity: .warning,
                pluginid: AnyCodable("example"),
                toolname: AnyCodable("report.run"),
                agentid: AnyCodable("main"),
                scope: scope,
                alloweddecisions: self == .standingGrant || self == .standingGrantTerms
                    ? [.allowAlways, .deny] : [.allowOnce, .deny])),
            status: "pending")))
    }
}

/// Synthetic, simulator-only captures of the same views used by direct conversations.
/// This mode never installs credentials or pretends to have reached a Gateway.
struct WatchDirectScreenshotView: View {
    let scenario: WatchDirectScreenshot

    var body: some View {
        NavigationStack {
            if let approval = self.scenario.approval {
                ScrollViewReader { reader in
                    ScrollView {
                        WatchDirectApprovalReview(approval: approval, canApprove: true, onDecision: { _ in })
                            .padding(.horizontal, 8)
                            .id("review")
                    }
                    .navigationTitle("Approvals")
                    .onAppear {
                        if [.paymentTerms, .standingGrantTerms, .unsupportedContext].contains(self.scenario) {
                            reader.scrollTo("review", anchor: .bottom)
                        }
                    }
                }
            } else if self.scenario == .noConversation {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Direct chat")
                            .font(WatchClawType.title(size: 18))
                        WatchDirectDeliveryStatus(status: self.scenario.status)
                    }
                    .padding(.horizontal, 8)
                }
            } else {
                WatchDirectSessionChooser(
                    sessions: [],
                    deliveryStatus: self.scenario.status,
                    canWrite: true,
                    busy: false,
                    onCreate: {},
                    onSelect: { _ in })
            }
        }
        .background(WatchClawStyle.background.ignoresSafeArea())
        .task {
            FileHandle.standardOutput.write(Data("watch-direct-proof-ready:\(self.scenario.rawValue)\n".utf8))
        }
    }
}
#endif
