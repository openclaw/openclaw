import OpenClawKit
import OpenClawProtocol
import SwiftUI

private struct ExecApprovalPromptDialogModifier: ViewModifier {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    @AccessibilityFocusState private var approvalCardFocused: Bool
    let suppressedApproval: NodeAppModel.ExecApprovalInboxKey?

    func body(content: Content) -> some View {
        let prompt = self.presentedPrompt
        ZStack {
            content
                .allowsHitTesting(prompt == nil)
                .accessibilityHidden(prompt != nil)

            if let prompt {
                ZStack {
                    Color.black.opacity(0.38)
                        .ignoresSafeArea()
                        .accessibilityHidden(true)

                    ExecApprovalPromptCard(
                        prompt: prompt,
                        isResolving: self.appModel.pendingExecApprovalPromptResolving,
                        canDismiss: self.appModel.pendingExecApprovalPromptCanDismiss,
                        errorText: self.appModel.pendingExecApprovalPromptErrorText,
                        resolvedText: self.appModel.pendingExecApprovalPromptResolvedText,
                        resolvedTone: self.appModel.pendingExecApprovalPromptOutcome?.tone,
                        onDecision: { decision in
                            Task {
                                await self.appModel.resolvePendingExecApprovalPrompt(decision: decision.rawValue)
                            }
                        },
                        onCancel: {
                            self.appModel.dismissPendingExecApprovalPrompt()
                        })
                        .frame(maxHeight: 680)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 16)
                        .frame(maxWidth: 460)
                        .accessibilityElement(children: .contain)
                        .accessibilityAddTraits(.isModal)
                        .accessibilityFocused(self.$approvalCardFocused)
                        .onAppear { self.approvalCardFocused = true }
                        .transition(.scale(scale: 0.98).combined(with: .opacity))
                }
                .zIndex(1)
            }
        }
        .onChange(of: self.presentedPromptKey) { _, key in
            self.approvalCardFocused = key != nil
        }
        .animation(.easeInOut(duration: 0.18), value: self.presentedPromptKey)
    }

    private var presentedPrompt: NodeAppModel.ExecApprovalPrompt? {
        guard let prompt = appModel.pendingExecApprovalPrompt,
              NodeAppModel.execApprovalInboxKey(prompt) != self.suppressedApproval
        else { return nil }
        return prompt
    }

    private var presentedPromptKey: NodeAppModel.ExecApprovalInboxKey? {
        NodeAppModel.execApprovalInboxKey(self.presentedPrompt)
    }
}

private struct ExecApprovalPromptCard: View {
    let prompt: NodeAppModel.ExecApprovalPrompt
    let isResolving: Bool
    let canDismiss: Bool
    let errorText: String?
    let resolvedText: String?
    let resolvedTone: NodeAppModel.ExecApprovalOutcomeTone?
    let onDecision: (ApprovalDecision) -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                self.reviewContent
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityIdentifier("exec-approval-review-scroll")

            Divider()

            self.actionFooter
                .padding(18)
                .accessibilityIdentifier("exec-approval-actions")
        }
        .proPanelSurface(tint: OpenClawBrand.accentHot, radius: 20, isProminent: true)
    }

    private var reviewContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                if self.prompt.kind != "exec" {
                    Text(verbatim: self.prompt.commandText)
                        .font(OpenClawType.headline)
                    if let description = self.prompt.descriptionText?.trimmedNonEmpty {
                        Text(verbatim: description)
                            .font(OpenClawType.subhead)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("Exec approval required")
                        .font(OpenClawType.headline)
                    Text("Review this exec request before continuing. Your decision will be sent back to the gateway.")
                        .font(OpenClawType.subhead)
                        .foregroundStyle(.secondary)
                }
            }

            if self.prompt.kind == "exec" {
                Text(self.prompt.commandText)
                    .font(OpenClawType.mono)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(
                        .black.opacity(0.14),
                        in: RoundedRectangle(cornerRadius: OpenClawRadius.md, style: .continuous))
            }

            if let warningText = self.prompt.warningText?.trimmedNonEmpty {
                Label {
                    Text(warningText)
                        .font(OpenClawType.footnote)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .foregroundStyle(OpenClawBrand.warn)
                .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 8) {
                if self.isPluginApproval {
                    if let pluginId = self.prompt.pluginId?.trimmedNonEmpty {
                        ExecApprovalPromptMetadataRow(label: "Plugin", value: pluginId)
                    }
                    if let toolName = self.prompt.toolName?.trimmedNonEmpty {
                        ExecApprovalPromptMetadataRow(label: "Tool", value: toolName)
                    }
                    if let severity = self.prompt.pluginSeverity?.trimmedNonEmpty {
                        ExecApprovalPromptMetadataRow(label: "Severity", value: severity)
                    }
                } else {
                    if let host = self.prompt.host?.trimmedNonEmpty {
                        ExecApprovalPromptMetadataRow(label: "Host", value: host)
                    }
                    if let nodeId = self.prompt.nodeId?.trimmedNonEmpty {
                        ExecApprovalPromptMetadataRow(label: "Node", value: nodeId)
                    }
                }
                if let agentId = self.prompt.agentId?.trimmedNonEmpty {
                    ExecApprovalPromptMetadataRow(label: "Agent", value: agentId)
                }
                if let expiresText = self.expiresText(self.prompt.expiresAtMs) {
                    ExecApprovalPromptMetadataRow(label: "Expires", value: expiresText)
                }
            }

            if let errorText = self.errorText?.trimmedNonEmpty {
                Text(errorText)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(OpenClawBrand.danger)
            }

            if let resolvedText = self.resolvedText?.trimmedNonEmpty {
                Text(resolvedText)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(self.resolvedColor)
            }

            if self.isResolving {
                HStack(spacing: 8) {
                    ProgressView()
                        .progressViewStyle(.circular)
                    Text("Resolving…")
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var isPluginApproval: Bool {
        self.prompt.kind == "plugin"
    }

    private var actionFooter: some View {
        VStack(spacing: 10) {
            if self.resolvedText == nil {
                if self.prompt.kind == "system-agent" {
                    ApprovalDashboardReviewButton(prompt: self.prompt)
                }
                if self.prompt.allowsAllowOnce {
                    approvalDialogButton(Text("Allow Once")) {
                        self.onDecision(.allowOnce)
                    }
                    .openClawProminentButton()
                    .disabled(self.isResolving)
                }

                if self.prompt.allowsAllowAlways {
                    approvalDialogButton(Text("Allow Always")) {
                        self.onDecision(.allowAlways)
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.isResolving)
                }

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        if self.prompt.allowsDeny {
                            self.denyButton
                        }
                        self.cancelButton
                    }

                    VStack(spacing: 10) {
                        if self.prompt.allowsDeny {
                            self.denyButton
                        }
                        self.cancelButton
                    }
                }
            } else {
                approvalDialogButton(Text("Dismiss"), role: .cancel, action: self.onCancel)
                    .buttonStyle(.bordered)
            }
        }
        .controlSize(.large)
        .frame(maxWidth: .infinity)
    }

    private var denyButton: some View {
        approvalDialogButton(Text("Deny"), role: .destructive) {
            self.onDecision(.deny)
        }
        .buttonStyle(.bordered)
        .disabled(self.isResolving)
    }

    private var cancelButton: some View {
        approvalDialogButton(Text("Cancel"), role: .cancel, action: self.onCancel)
            .buttonStyle(.bordered)
            .disabled(!self.canDismiss)
    }

    private var resolvedColor: Color {
        switch self.resolvedTone {
        case .success:
            OpenClawBrand.ok
        case .danger:
            OpenClawBrand.danger
        case .warning:
            OpenClawBrand.warn
        case .neutral, nil:
            .secondary
        }
    }

    private func expiresText(_ expiresAtMs: Int64?) -> String? {
        guard let expiresAtMs else { return nil }
        let remainingSeconds = Int((Double(expiresAtMs) / 1000.0) - Date().timeIntervalSince1970)
        if remainingSeconds <= 0 {
            return String(localized: "expired")
        }
        if remainingSeconds < 60 {
            return String(localized: "under a minute")
        }
        if remainingSeconds < 3600 {
            let minutes = Int(ceil(Double(remainingSeconds) / 60.0))
            return String(
                AttributedString(
                    localized: "about ^[\(minutes) minute](inflect: true)")
                    .characters)
        }
        let hours = Int(ceil(Double(remainingSeconds) / 3600.0))
        return String(
            AttributedString(
                localized: "about ^[\(hours) hour](inflect: true)")
                .characters)
    }
}

struct ApprovalDashboardReviewButton: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var isPresented = false
    @State private var authorityGeneration: UInt64?
    let prompt: NodeAppModel.ExecApprovalPrompt

    var body: some View {
        Group {
            if self.isCurrentPrompt {
                Button {
                    guard self.isCurrentPrompt else { return }
                    self.authorityGeneration = self.appModel.operatorAuthorityGeneration
                    self.isPresented = true
                } label: {
                    Text("Review in Dashboard")
                        .font(OpenClawType.subheadSemiBold)
                }
                .accessibilityIdentifier("approval-dashboard-review")
            } else {
                Text("Open Dashboard on an authorized device to review this approval.")
                    .font(OpenClawType.footnote)
            }
        }
        .sheet(isPresented: self.$isPresented) {
            if self.isCurrentPrompt,
               self.authorityGeneration == self.appModel.operatorAuthorityGeneration,
               let id = AuthenticatedControlUI.percentEncodedPathSegment(self.prompt.id)
            {
                DashboardPageScreen(
                    path: "/approve/\(id)",
                    title: String(localized: "Review approval"),
                    onClose: { self.isPresented = false })
            }
        }
        .onChange(of: self.appModel.operatorAuthorityGeneration) { _, _ in
            self.isPresented = false
        }
    }

    private var isCurrentPrompt: Bool {
        self.appModel.hasOperatorAdminScope &&
            self.prompt.attentionSource?.authorityGeneration == self.appModel.operatorAuthorityGeneration &&
            self.appModel.pendingExecApprovalInboxItems.contains { $0.prompt == self.prompt }
    }
}

@MainActor
func approvalDialogButton(
    _ title: Text,
    role: ButtonRole? = nil,
    action: @escaping () -> Void) -> some View
{
    Button(role: role, action: action) {
        title
            .font(OpenClawType.subheadSemiBold)
            .frame(maxWidth: .infinity)
    }
}

private struct ExecApprovalPromptMetadataRow: View {
    let label: LocalizedStringKey
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(self.label)
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
            Text(verbatim: self.value)
                .font(OpenClawType.footnote)
                .textSelection(.enabled)
        }
    }
}

extension View {
    func execApprovalPromptDialog(
        suppressedApproval: NodeAppModel.ExecApprovalInboxKey? = nil) -> some View
    {
        modifier(ExecApprovalPromptDialogModifier(suppressedApproval: suppressedApproval))
    }
}
