import Observation
import SwiftUI

private struct ExecApprovalPromptDialogModifier: ViewModifier {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    @AccessibilityFocusState private var approvalCardFocused: Bool
    let suppressedApproval: NodeAppModel.ExecApprovalInboxKey?
    let dashboardPresentation: ApprovalDashboardPresentationState?

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
                        dashboardPresentation: self.dashboardPresentation,
                        isResolving: self.appModel.pendingExecApprovalPromptResolving,
                        canDismiss: self.appModel.pendingExecApprovalPromptCanDismiss,
                        errorText: self.appModel.pendingExecApprovalPromptErrorText,
                        resolvedText: self.appModel.pendingExecApprovalPromptResolvedText,
                        resolvedTone: self.appModel.pendingExecApprovalPromptOutcome?.tone,
                        onAllowOnce: {
                            Task {
                                await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-once")
                            }
                        },
                        onAllowAlways: {
                            Task {
                                await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-always")
                            }
                        },
                        onDeny: {
                            Task {
                                await self.appModel.resolvePendingExecApprovalPrompt(decision: "deny")
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
        .onChange(of: self.reviewOwner) { oldOwner, newOwner in
            self.dashboardPresentation?.ownerDidChange(from: oldOwner, to: newOwner)
        }
        .animation(.easeInOut(duration: 0.18), value: self.presentedPromptKey)
    }

    private var presentedPrompt: NodeAppModel.ExecApprovalPrompt? {
        guard let prompt = appModel.pendingExecApprovalPrompt,
              NodeAppModel.execApprovalInboxKey(prompt) != self.suppressedApproval
        else { return nil }
        return prompt
    }

    private var reviewOwner: ApprovalDashboardPresentationState.Owner? {
        guard self.presentedPrompt?.kind == "system-agent",
              self.appModel.pendingExecApprovalPromptResolvedText == nil,
              let key = self.presentedPromptKey else { return nil }
        return .init(key: key, authorityGeneration: self.appModel.operatorAuthorityGeneration)
    }

    private var presentedPromptKey: NodeAppModel.ExecApprovalInboxKey? {
        NodeAppModel.execApprovalInboxKey(self.presentedPrompt)
    }
}

private struct ExecApprovalPromptCard: View {
    let prompt: NodeAppModel.ExecApprovalPrompt
    let dashboardPresentation: ApprovalDashboardPresentationState?
    let isResolving: Bool
    let canDismiss: Bool
    let errorText: String?
    let resolvedText: String?
    let resolvedTone: NodeAppModel.ExecApprovalOutcomeTone?
    let onAllowOnce: () -> Void
    let onAllowAlways: () -> Void
    let onDeny: () -> Void
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
                    if let description = self.normalized(self.prompt.descriptionText) {
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

            if let warningText = self.normalized(self.prompt.warningText) {
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
                    if let pluginId = self.normalized(self.prompt.pluginId) {
                        ExecApprovalPromptMetadataRow(label: "Plugin", value: pluginId)
                    }
                    if let toolName = self.normalized(self.prompt.toolName) {
                        ExecApprovalPromptMetadataRow(label: "Tool", value: toolName)
                    }
                    if let severity = self.normalized(self.prompt.pluginSeverity) {
                        ExecApprovalPromptMetadataRow(label: "Severity", value: severity)
                    }
                } else {
                    if let host = self.normalized(self.prompt.host) {
                        ExecApprovalPromptMetadataRow(label: "Host", value: host)
                    }
                    if let nodeId = self.normalized(self.prompt.nodeId) {
                        ExecApprovalPromptMetadataRow(label: "Node", value: nodeId)
                    }
                }
                if let agentId = self.normalized(self.prompt.agentId) {
                    ExecApprovalPromptMetadataRow(label: "Agent", value: agentId)
                }
                if let expiresText = self.expiresText(self.prompt.expiresAtMs) {
                    ExecApprovalPromptMetadataRow(label: "Expires", value: expiresText)
                }
            }

            if let errorText = self.normalized(self.errorText) {
                Text(errorText)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(OpenClawBrand.danger)
            }

            if let resolvedText = self.normalized(self.resolvedText) {
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
                    ApprovalDashboardReviewButton(prompt: self.prompt, presentation: self.dashboardPresentation)
                }
                if self.prompt.allowsAllowOnce {
                    Button {
                        self.onAllowOnce()
                    } label: {
                        Text("Allow Once")
                            .font(OpenClawType.subheadSemiBold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.isResolving)
                }

                if self.prompt.allowsAllowAlways {
                    Button {
                        self.onAllowAlways()
                    } label: {
                        Text("Allow Always")
                            .font(OpenClawType.subheadSemiBold)
                            .frame(maxWidth: .infinity)
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
                Button(role: .cancel) {
                    self.onCancel()
                } label: {
                    Text("Dismiss")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .controlSize(.large)
        .frame(maxWidth: .infinity)
    }

    private var denyButton: some View {
        Button(role: .destructive) {
            self.onDeny()
        } label: {
            Text("Deny")
                .font(OpenClawType.subheadSemiBold)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(self.isResolving)
    }

    private var cancelButton: some View {
        Button(role: .cancel) {
            self.onCancel()
        } label: {
            Text("Cancel")
                .font(OpenClawType.subheadSemiBold)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(!self.canDismiss)
    }

    private func normalized(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
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

@MainActor
@Observable
final class ApprovalDashboardPresentationState {
    struct Owner: Equatable {
        let key: NodeAppModel.ExecApprovalInboxKey
        let authorityGeneration: UInt64
    }

    var isPresented = false
    private(set) var owner: Owner?
    private(set) var presentationID: UUID?
    var authorityGeneration: UInt64? {
        self.owner?.authorityGeneration
    }

    func isCurrent(_ prompt: NodeAppModel.ExecApprovalPrompt, appModel: NodeAppModel) -> Bool {
        appModel.hasOperatorAdminScope &&
            prompt.attentionSource?.authorityGeneration == appModel.operatorAuthorityGeneration &&
            appModel.pendingExecApprovalInboxItems.contains { $0.prompt == prompt }
    }

    func open(
        _ prompt: NodeAppModel.ExecApprovalPrompt,
        appModel: NodeAppModel,
        admit: (@MainActor () -> Bool)?)
    {
        guard let key = NodeAppModel.execApprovalInboxKey(prompt),
              self.isCurrent(prompt, appModel: appModel), admit?() ?? true else { return }
        self.owner = Owner(key: key, authorityGeneration: appModel.operatorAuthorityGeneration)
        self.presentationID = UUID()
        self.isPresented = true
    }

    func binding(appModel: NodeAppModel, admit: (@MainActor () -> Bool)?) -> Binding<Bool> {
        let generation = self.authorityGeneration
        let presentationID = self.presentationID
        return Binding(get: { self.isPresented }, set: { value in
            guard value != self.isPresented,
                  let presentationID, presentationID == self.presentationID,
                  generation == self.authorityGeneration,
                  generation == appModel.operatorAuthorityGeneration,
                  admit?() ?? true else { return }
            self.isPresented = value
        })
    }

    /// onChange invokes the new body closure. Retire its departed owner value,
    /// never a presentation ID captured from that new body.
    func ownerDidChange(from oldOwner: Owner?, to newOwner: Owner?) {
        guard let oldOwner, oldOwner != newOwner, self.owner == oldOwner else { return }
        self.reset()
    }

    func authorityDidChange(from oldGeneration: UInt64, to newGeneration: UInt64) {
        guard oldGeneration != newGeneration, self.authorityGeneration == oldGeneration else { return }
        self.reset()
    }

    func retire(_ presentationID: UUID?) {
        guard let presentationID, presentationID == self.presentationID else { return }
        self.reset()
    }

    func reset() {
        self.presentationID = nil
        self.isPresented = false
        self.owner = nil
    }
}

struct ApprovalDashboardReviewButton: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.userNavigationAction) private var userNavigationAction
    @State private var state: ApprovalDashboardPresentationState
    let prompt: NodeAppModel.ExecApprovalPrompt

    init(prompt: NodeAppModel.ExecApprovalPrompt, presentation: ApprovalDashboardPresentationState? = nil) {
        self.prompt = prompt
        _state = State(initialValue: presentation ?? ApprovalDashboardPresentationState())
    }

    var body: some View {
        let action = self.userNavigationAction
        let generation = self.state.authorityGeneration
        let presentationID = self.state.presentationID
        let presentation = self.state.binding(appModel: self.appModel, admit: action)
        return Group {
            if self.isCurrentPrompt {
                Button {
                    self.state.open(self.prompt, appModel: self.appModel, admit: action)
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
        .sheet(isPresented: presentation) {
            if self.isCurrentPrompt,
               self.state.authorityGeneration == self.appModel.operatorAuthorityGeneration,
               let id = AuthenticatedControlUI.percentEncodedPathSegment(self.prompt.id)
            {
                DashboardPageScreen(
                    path: "/approve/\(id)",
                    title: String(localized: "Review approval"),
                    onClose: { presentation.wrappedValue = false })
                    .environment(\.userNavigationAction) {
                        self.state.isPresented && presentationID == self.state.presentationID &&
                            self.isCurrentPrompt && generation == self.state
                            .authorityGeneration &&
                            generation == self.appModel.operatorAuthorityGeneration && (action?() ?? true)
                    }
            }
        }
        .onChange(of: self.appModel.operatorAuthorityGeneration) { oldGeneration, newGeneration in
            self.state.authorityDidChange(from: oldGeneration, to: newGeneration)
        }
    }

    private var isCurrentPrompt: Bool {
        self.state.isCurrent(self.prompt, appModel: self.appModel)
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
        suppressedApproval: NodeAppModel.ExecApprovalInboxKey? = nil,
        dashboardPresentation: ApprovalDashboardPresentationState? = nil) -> some View
    {
        modifier(ExecApprovalPromptDialogModifier(
            suppressedApproval: suppressedApproval, dashboardPresentation: dashboardPresentation))
    }
}
