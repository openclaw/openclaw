import OpenClawKit
import SwiftUI
import UIKit

struct GatewayProblemBanner: View {
    let problem: GatewayConnectionProblem
    var primaryActionTitle: String?
    var onPrimaryAction: (() -> Void)?
    var onShowDetails: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: self.iconName)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(self.tint)
                    .frame(width: 20)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(self.problem.title)
                            .font(.subheadline.weight(.semibold))
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Text(self.ownerLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }

                    Text(self.problem.message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if let requestId = self.problem.requestId {
                        Text("Request ID: \(requestId)")
                            .font(.system(.caption, design: .monospaced).weight(.medium))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }

            HStack(spacing: 10) {
                if let primaryActionTitle, let onPrimaryAction {
                    Button(primaryActionTitle, action: onPrimaryAction)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
                if let onShowDetails {
                    Button("Details", action: onShowDetails)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            .thinMaterial,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
    }

    private var iconName: String {
        switch self.problem.kind {
        case .pairingRequired,
            .pairingRoleUpgradeRequired,
            .pairingScopeUpgradeRequired,
            .pairingMetadataUpgradeRequired:
            return "person.crop.circle.badge.clock"
        case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
            return "wifi.exclamationmark"
        case .deviceIdentityRequired,
            .deviceSignatureExpired,
            .deviceNonceRequired,
            .deviceNonceMismatch,
            .deviceSignatureInvalid,
            .devicePublicKeyInvalid,
            .deviceIdMismatch:
            return "lock.shield"
        default:
            return "exclamationmark.triangle.fill"
        }
    }

    private var tint: Color {
        switch self.problem.kind {
        case .pairingRequired,
            .pairingRoleUpgradeRequired,
            .pairingScopeUpgradeRequired,
            .pairingMetadataUpgradeRequired:
            return .orange
        case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
            return .yellow
        default:
            return .red
        }
    }

    private var ownerLabel: String {
        switch self.problem.owner {
        case .gateway:
            return "Fix on gateway"
        case .iphone:
            return "Fix on iPhone"
        case .both:
            return "Check both"
        case .network:
            return "Check network"
        case .unknown:
            return "Needs attention"
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
                            .font(.title3.weight(.semibold))
                        Text(self.problem.message)
                            .font(.body)
                            .foregroundStyle(.secondary)
                        Text(self.ownerSummary)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }

                if let requestId = self.problem.requestId {
                    Section("Request") {
                        Text(verbatim: requestId)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                        Button("Copy request ID") {
                            UIPasteboard.general.string = requestId
                            self.copyFeedback = "Copied request ID"
                        }
                    }
                }

                if let actionCommand = self.problem.actionCommand {
                    Section("Gateway command") {
                        Text(verbatim: actionCommand)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                        Button("Copy command") {
                            UIPasteboard.general.string = actionCommand
                            self.copyFeedback = "Copied command"
                        }
                    }
                }

                if let docsURL = self.problem.docsURL {
                    Section("Help") {
                        Link(destination: docsURL) {
                            Label("Open docs", systemImage: "book")
                        }
                        Text(verbatim: docsURL.absoluteString)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                if let technicalDetails = self.problem.technicalDetails {
                    Section("Technical details") {
                        Text(verbatim: technicalDetails)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                if let copyFeedback {
                    Section {
                        Text(copyFeedback)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Connection problem")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let primaryActionTitle, let onPrimaryAction {
                        Button(primaryActionTitle) {
                            self.dismiss()
                            onPrimaryAction()
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        self.dismiss()
                    }
                }
            }
        }
    }

    private var ownerSummary: String {
        switch self.problem.owner {
        case .gateway:
            return "Primary fix: gateway"
        case .iphone:
            return "Primary fix: this iPhone"
        case .both:
            return "Primary fix: check both this iPhone and the gateway"
        case .network:
            return "Primary fix: network or remote access"
        case .unknown:
            return "Primary fix: review details and retry"
        }
    }
}
