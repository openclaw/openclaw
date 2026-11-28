import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct ChatSessionApproval: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var reviewedItem: NodeAppModel.ExecApprovalInboxItem?
    @State private var submitting = false
    let sessionKey: String
    let agentID: String?
    let agentName: String

    var body: some View {
        if let item = self.item {
            let isSelected = NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt) == item.id
            let outcome = isSelected ? self.appModel.pendingExecApprovalPromptResolvedText : nil
            SessionApprovalCard(
                prompt: item.prompt,
                agentName: self.agentName,
                isResolving: self.submitting || (isSelected && self.appModel.pendingExecApprovalPromptResolving),
                // A failure for lack of connection is the strip's ("Can’t reach …"); the card only re-enables.
                error: isSelected && !self.appModel.pendingExecApprovalFailedUnreachable
                    ? self.appModel.pendingExecApprovalPromptErrorText : nil,
                outcome: outcome,
                decide: { decision in
                    guard !self.submitting else { return }
                    self.submitting = true
                    self.reviewedItem = item
                    Task {
                        defer { self.submitting = false }
                        await self.appModel.resolveSessionApproval(item, decision: decision)
                    }
                },
                dismiss: {
                    if NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt) == item.id,
                       self.appModel.pendingExecApprovalPromptResolvedText != nil
                    {
                        self.appModel.dismissPendingExecApprovalPrompt()
                    }
                    self.reviewedItem = nil
                })
                .id(item.id)
        }
    }

    private var item: NodeAppModel.ExecApprovalInboxItem? {
        if let reviewedItem,
           self.appModel.currentApprovalSource(for: reviewedItem.prompt) != nil,
           NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt) == reviewedItem.id,
           self.appModel.pendingExecApprovalPromptResolvedText != nil
        {
            return reviewedItem
        }
        return self.appModel.pendingApproval(forSession: self.sessionKey, agentID: self.agentID)
    }
}

private struct SessionApprovalCard: View {
    let prompt: NodeAppModel.ExecApprovalPrompt
    let agentName: String
    let isResolving: Bool
    let error: String?
    let outcome: String?
    let decide: (ApprovalDecision) -> Void
    let dismiss: () -> Void

    private var isExec: Bool {
        self.prompt.kind == ApprovalKind.exec.rawValue
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(self.isExec
                    ? String(format: String(localized: "%@ wants to run a command"), self.agentName)
                    : String(localized: "Approval needed"))
                    .font(OpenClawType.subheadSemiBold)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if self.outcome == nil, let expiry = self.prompt.expiresAtMs {
                    let end = Date(timeIntervalSince1970: Double(expiry) / 1000)
                    let now = Date.now
                    if end > now {
                        Text(timerInterval: now...end, countsDown: true, showsHours: false)
                            .font(OpenClawType.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .fixedSize()
                            .accessibilityLabel(String(localized: "Expires"))
                            .accessibilityValue(Text(end, style: .relative))
                    }
                }
            }
            DisclosureGroup {
                ViewThatFits(in: .vertical) {
                    self.details
                    ScrollView { self.details }
                        .defaultScrollAnchor(.top)
                        .frame(height: 144)
                }
                .frame(maxHeight: 144)
                .padding(.top, 7)
            } label: {
                HStack(spacing: 7) {
                    if self.isExec {
                        Image(systemName: "terminal")
                            .imageScale(.small)
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                    Text(verbatim: self.prompt.commandText)
                        .font(self.isExec ? OpenClawType.mono : OpenClawType.subheadMedium)
                        .lineLimit(2)
                        .foregroundStyle(.primary)
                }
            }
            .padding(9)
            .background(OpenClawBrand.surfaceMuted, in: RoundedRectangle(cornerRadius: OpenClawRadius.md))
            .tint(.secondary)
            .accessibilityIdentifier("chat-approval-details")
            if let warning = self.prompt.warningText, !warning.isEmpty {
                Text(verbatim: warning)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.primary)
            }
            if let error = self.error {
                Text(verbatim: error)
                    .font(OpenClawType.caption)
                    .foregroundStyle(OpenClawBrand.danger)
            }
            if let outcome = self.outcome {
                Text(verbatim: outcome)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                self.action("Dismiss", action: self.dismiss)
                    .buttonStyle(.bordered)
                    .tint(.primary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            } else {
                if self.isResolving, self.error == nil {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Resolving…").font(OpenClawType.caption)
                    }
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                }
                ViewThatFits(in: .horizontal) {
                    self.actions(HStackLayout(spacing: 6))
                    self.actions(VStackLayout(alignment: .trailing, spacing: 4))
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .controlSize(.regular)
                .disabled(self.isResolving)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OpenClawBrand.surfaceRaised, in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(.primary.opacity(0.10), lineWidth: 1)
                .allowsHitTesting(false)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-session-approval")
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(verbatim: self.prompt.commandText)
                .font(self.isExec ? OpenClawType.mono : OpenClawType.subhead)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let description = self.prompt.descriptionText {
                Text(verbatim: description).font(OpenClawType.caption)
            }
            self.metadata(String(localized: "Host"), self.prompt.host)
            self.metadata(String(localized: "Node"), self.prompt.nodeId)
            self.metadata(String(localized: "Agent"), self.prompt.agentId)
            self.metadata(String(localized: "Plugin"), self.prompt.pluginId)
            self.metadata(String(localized: "Tool"), self.prompt.toolName)
            self.metadata(String(localized: "Severity"), self.prompt.pluginSeverity)
            if let expiry = self.prompt.expiresAtMs {
                self.metadata(
                    String(localized: "Expires"),
                    Date(timeIntervalSince1970: Double(expiry) / 1000).formatted())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func metadata(_ title: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            LabeledContent {
                Text(verbatim: value)
                    .font(OpenClawType.caption)
                    .multilineTextAlignment(.trailing)
            } label: {
                Text(verbatim: title)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func actions(_ layout: some Layout) -> some View {
        layout {
            if self.prompt.kind == ApprovalKind.systemAgent.rawValue {
                ApprovalDashboardReviewButton(prompt: self.prompt)
            }
            if self.prompt.allowsDeny {
                self.action("Deny") { self.decide(.deny) }
                    .buttonStyle(.plain)
                    .padding(7)
            }
            if self.prompt.allowsAllowAlways {
                self.action("Always allow") { self.decide(.allowAlways) }
                    .buttonStyle(.bordered)
                    .tint(.primary)
            }
            if self.prompt.allowsAllowOnce {
                self.action("Allow once") { self.decide(.allowOnce) }
                    .buttonStyle(.borderedProminent)
                    .tint(OpenClawBrand.accent)
            }
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    private func action(_ title: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(OpenClawType.captionMedium)
                .frame(minHeight: 30)
        }
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
                    Text("Review in web app")
                        .font(OpenClawType.subheadSemiBold)
                }
                .accessibilityIdentifier("approval-dashboard-review")
            } else {
                Text("Open OpenClaw on an authorized device to review this approval.")
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
                    .openClawSheetHeaderEdge()
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
