import OpenClawKit
import SwiftUI
import UIKit

struct GatewayProblemBanner: View {
    let problem: GatewayConnectionProblem
    var primaryActionTitle: String?
    var onPrimaryAction: (() -> Void)?
    var onShowDetails: (() -> Void)?

    var body: some View {
        OpenClawNoticeBanner(
            icon: self.iconName,
            title: self.problem.title,
            message: self.problem.message,
            ownerLabel: self.ownerLabel,
            tint: self.tint,
            detail: self.problem.requestId.map(OpenClawNoticeDetail.requestID),
            primaryActionTitle: self.primaryActionTitle,
            onPrimaryAction: self.onPrimaryAction,
            secondaryActionTitle: "Details",
            onSecondaryAction: self.onShowDetails)
    }

    private var iconName: String {
        switch self.problem.kind {
        case .pairingRequired,
             .pairingRoleUpgradeRequired,
             .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired:
            "person.crop.circle.badge.clock"
        case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
            "wifi.exclamationmark"
        case .deviceIdentityRequired,
             .deviceSignatureExpired,
             .deviceNonceRequired,
             .deviceNonceMismatch,
             .deviceSignatureInvalid,
             .devicePublicKeyInvalid,
             .deviceIdMismatch:
            "lock.shield"
        default:
            "exclamationmark.triangle.fill"
        }
    }

    private var tint: Color {
        switch self.problem.kind {
        case .pairingRequired,
             .pairingRoleUpgradeRequired,
             .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired:
            OpenClawBrand.warn
        case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
            OpenClawBrand.warn
        default:
            OpenClawBrand.danger
        }
    }

    private var ownerLabel: String {
        switch self.problem.owner {
        case .gateway:
            "Fix on gateway"
        case .iphone:
            "Fix on this device"
        case .both:
            "Check both"
        case .network:
            "Check network"
        case .unknown:
            "Needs attention"
        }
    }
}

struct GatewayProblemDetailsSheet: View {
    @Environment(\.dismiss) private var dismiss

    let problem: GatewayConnectionProblem
    var primaryActionTitle: String?
    var onPrimaryAction: (() -> Void)?

    @State private var copyFeedback: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(self.problem.title)
                            .font(OpenClawType.title3)
                        Text(self.problem.message)
                            .font(OpenClawType.body)
                            .foregroundStyle(.secondary)
                        Text(self.ownerSummary)
                            .font(OpenClawType.footnoteSemiBold)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }

                if let requestId = self.problem.requestId {
                    Section {
                        Text(verbatim: requestId)
                            .font(OpenClawType.mono)
                            .textSelection(.enabled)
                        Button {
                            UIPasteboard.general.string = requestId
                            self.copyFeedback = "Copied request ID"
                        } label: {
                            Text("Copy request ID")
                                .font(OpenClawType.subheadSemiBold)
                        }
                        .font(OpenClawType.subheadSemiBold)
                    } header: {
                        Text("Request")
                            .font(OpenClawType.captionSemiBold)
                    }
                }

                if let actionCommand = self.problem.actionCommand {
                    Section {
                        Text(verbatim: actionCommand)
                            .font(OpenClawType.mono)
                            .textSelection(.enabled)
                        Button {
                            UIPasteboard.general.string = actionCommand
                            self.copyFeedback = "Copied command"
                        } label: {
                            Text("Copy command")
                                .font(OpenClawType.subheadSemiBold)
                        }
                        .font(OpenClawType.subheadSemiBold)
                    } header: {
                        Text("Gateway command")
                            .font(OpenClawType.captionSemiBold)
                    }
                }

                if let docsURL = self.problem.docsURL {
                    Section {
                        Link(destination: docsURL) {
                            Label("Open docs", systemImage: "book")
                                .font(OpenClawType.subheadSemiBold)
                        }
                        .font(OpenClawType.subheadSemiBold)
                        Text(verbatim: docsURL.absoluteString)
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    } header: {
                        Text("Help")
                            .font(OpenClawType.captionSemiBold)
                    }
                }

                if let technicalDetails = self.problem.technicalDetails {
                    Section {
                        Text(verbatim: technicalDetails)
                            .font(OpenClawType.monoFootnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    } header: {
                        Text("Technical details")
                            .font(OpenClawType.captionSemiBold)
                    }
                }

                if let copyFeedback {
                    Section {
                        Text(copyFeedback)
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Connection problem")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Connection problem")
                        .font(OpenClawType.headline)
                }
                ToolbarItem(placement: .topBarLeading) {
                    if let primaryActionTitle, let onPrimaryAction {
                        Button {
                            self.dismiss()
                            onPrimaryAction()
                        } label: {
                            Text(primaryActionTitle)
                                .font(OpenClawType.subheadSemiBold)
                        }
                        .font(OpenClawType.subheadSemiBold)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.dismiss()
                    } label: {
                        Text("Done")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .font(OpenClawType.subheadSemiBold)
                }
            }
        }
    }

    private var ownerSummary: String {
        switch self.problem.owner {
        case .gateway:
            "Primary fix: gateway"
        case .iphone:
            "Primary fix: this device"
        case .both:
            "Primary fix: check both this device and the gateway"
        case .network:
            "Primary fix: network or remote access"
        case .unknown:
            "Primary fix: review details and retry"
        }
    }
}
