import SwiftUI
import OpenClawKit

struct OnboardingReachabilityContent: View {
    let unavailableReason: String?
    let signIn: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Text("Reach it from anywhere?").font(.largeTitle.weight(.semibold))
            Text("Use OpenClaw ID to reach this Mac’s assistant from your other devices, without a VPN.")
                .foregroundStyle(.secondary).multilineTextAlignment(.center)
            VStack(alignment: .leading, spacing: 18) {
                Label("Keep your assistant on this Mac", systemImage: "desktopcomputer")
                Label("Approve each device that connects", systemImage: "checkmark.shield")
                Label("Save a recovery kit that only you hold", systemImage: "key")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 16))
            Button("Sign in with OpenClaw ID", action: self.signIn)
                .buttonStyle(.borderedProminent)
                .disabled(self.unavailableReason != nil)
            if let unavailableReason {
                Text(unavailableReason).font(.callout).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Text("Optional. Choose Not now to finish setup on this Mac.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: 520)
    }
}

struct OnboardingOpenClawIDView: View {
    @Bindable var model: OnboardingOpenClawIDModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 20) {
            OnboardingOpenClawIDContent(
                step: self.model.step,
                unavailableReason: self.model.step == .signIn
                    ? self.model.accountUnavailableReason : self.model.unavailableReason,
                invitation: self.model.pendingInvitation ?? "",
                action: { self.model.perform($0) })
                .disabled(self.model.busy || self.model.unavailableReason != nil)
            if self.model.busy, !self.model.step.isAwaitingApproval { ProgressView("Working…") }
            if let error = self.model.error {
                Text(error).foregroundStyle(.orange).font(.callout)
            }
            Button("Close") { self.dismiss() }.keyboardShortcut(.cancelAction)
        }
        .padding(28)
        .frame(width: 574)
        .onDisappear { self.model.cancel() }
    }
}

/// The same presentation is used by native onboarding and credential-free render fixtures.
struct OnboardingOpenClawIDContent: View {
    let step: OnboardingOpenClawIDStep
    let unavailableReason: String?
    var invitation = ""
    let action: (OnboardingOpenClawIDAction) -> Void
    @State private var invitationText = ""
    @State private var discoveryOrigin = ""
    @State private var discoveryEdited = false

    var body: some View {
        VStack(spacing: 18) {
            self.content
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: 520)
        .onAppear {
            if self.invitationText.isEmpty { self.invitationText = self.invitation }
            self.prefillDiscovery()
        }
        .onChange(of: self.invitation) { _, value in
            self.invitationText = value
            self.prefillDiscovery()
        }
        .onChange(of: self.invitationText) { _, _ in self.prefillDiscovery() }
    }

    /// Shows the origin the link or command carries; a value the person typed is kept.
    private func prefillDiscovery() {
        guard !self.discoveryEdited else { return }
        let input = try? OnboardingNodeInvitationInput(self.invitationText)
        let carried = input?.discoveryOrigin ??
            input.flatMap { try? OpenClawIDNodeEnrollmentLink($0.link) }?.discoveryOrigin?.absoluteString
        self.discoveryOrigin = carried ?? ""
    }

    @ViewBuilder
    private var content: some View {
        switch self.step {
        case .nodeInvitation:
            self.heading("Add this Mac to a claw", subtitle: "Paste the invite the claw’s owner sent you.")
            if let unavailableReason { Text(unavailableReason).foregroundStyle(.secondary) }
            TextField(
                "openclaw-node://join#… or the full command",
                text: self.$invitationText,
                axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(3...5)
                .multilineTextAlignment(.leading)
            DisclosureGroup("Advanced") {
                TextField(
                    "Discovery origin (https://…)",
                    text: Binding(
                        get: { self.discoveryOrigin },
                        set: {
                            self.discoveryOrigin = $0
                            self.discoveryEdited = true
                        }))
                    .textFieldStyle(.roundedBorder)
                    .padding(.top, 6)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Continue") {
                let text = self.invitationText
                self.invitationText = ""
                self.action(.submitNodeInvitation(text: text, discoveryOrigin: self.discoveryEdited ? self.discoveryOrigin : ""))
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.invitationText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Text("The invite works once. It is not saved, and no Gateway token or account sign-in is needed.")
                .font(.caption).foregroundStyle(.secondary)
        case let .nodeConnection(claw, _):
            self.heading("This Mac joined \(claw)", subtitle: "The owner approved it as a node only.")
            self.row(
                "Node approved",
                detail: "This Mac connects in the background; the menu bar shows its status.",
                icon: "checkmark.circle")
            self.row(
                "Chat isn’t available",
                detail: "The owner did not allow chat and dashboard from this Mac. Ask them to add it again with chat.",
                icon: "bubble.left.and.bubble.right")
        case .signIn:
            self.heading("Sign in with OpenClaw ID", subtitle: "Choose an account to find your OpenClaw.")
            Image(systemName: "person.crop.circle").font(.system(size: 56)).foregroundStyle(.tint)
            Button("Sign in") { self.action(.signIn) }
                .buttonStyle(.borderedProminent).disabled(self.unavailableReason != nil)
            if let unavailableReason {
                Text(unavailableReason).font(.callout).foregroundStyle(.secondary)
            }
        case let .claws(account, claws):
            self.heading("Which claw?", subtitle: "Signed in as \(account).")
            if claws.isEmpty {
                Text("No claws found for this account. Use an invitation or choose another connection method.")
                    .foregroundStyle(.secondary)
            }
            ForEach(claws) { claw in
                Button { self.action(.selectClaw(claw.id)) } label: {
                    self.row(
                        claw.name,
                        detail: "\(claw.relationship) · \(claw.online ? "Online" : "Offline")",
                        icon: "desktopcomputer")
                }
                .buttonStyle(.plain).disabled(!claw.online)
            }
        case let .recoveryKit(hostname, saved):
            self.heading("Save your recovery kit", subtitle: "Keep the recovery kit for \(hostname) somewhere safe.")
            self.row(
                "You hold the keys",
                detail: "The kit is the only way to recover access if this Mac’s keys are lost.",
                icon: "key")
            Text("The native enrollment service saves your kit securely. It is never sent to the Gateway.")
                .font(.callout).foregroundStyle(.secondary)
            Button(saved ? "Save again…" : "Save recovery kit…") { self.action(.saveRecoveryKit) }
            Button("I’ve saved it") { self.action(.confirmRecoveryKit) }
                .buttonStyle(.borderedProminent).disabled(!saved)
        case let .addMac(claw, device, capabilities):
            self.heading("Add this Mac to \(claw)", subtitle: "One approval from the owner sets everything up.")
            self.row(device, detail: "macOS · this device", icon: "laptopcomputer")
            self.row(
                "Chat and dashboard",
                detail: "Use \(claw) from this Mac, without a VPN or Gateway token.",
                icon: "bubble.left.and.bubble.right")
            ScrollView {
                self.row("Node capabilities", detail: capabilities, icon: "wrench.and.screwdriver")
            }
            .frame(maxHeight: 140)
            Text("The owner can approve the node alone. Gateway configuration and access management stay with owners.")
                .font(.callout).foregroundStyle(.secondary)
            Button("Request access") { self.action(.requestNode) }.buttonStyle(.borderedProminent)
        case let .compareCode(claw, device, code, approvalURL):
            self.heading("Compare the code", subtitle: "On \(claw), open Access and find \(device).")
            Text(code).font(.system(size: 42, weight: .semibold, design: .monospaced)).textSelection(.enabled)
            Text("The owner approves only if all six digits match.")
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Waiting for the owner to approve…").foregroundStyle(.secondary)
            }
            self.browserApproval(approvalURL)
        case let .chatAccess(claw, approvalURL):
            self.heading(
                "Approve your chat access",
                subtitle: "Node access to \(claw) is approved. Chat is not connected yet.")
            self.row(
                "1. Node approved",
                detail: "The assistant can use the Mac capabilities you approved.",
                icon: "checkmark.circle")
            self.row(
                "2. Chat access needs approval",
                detail: """
                Sign in and redeem a separate operator invitation. The owner approves this separately; \
                there is no node comparison code for this grant.
                """,
                icon: "bubble.left.and.bubble.right")
            self.browserApproval(approvalURL)
            Button("Continue chat setup") { self.action(.requestChat) }.buttonStyle(.borderedProminent)
        case let .connected(claw):
            self.heading("You’re all set!", subtitle: "\(claw) approved this Mac through OpenClaw ID.")
            self.row(
                "Node approved",
                detail: "This Mac’s approved capabilities connect in the background.",
                icon: "checkmark.circle")
            self.row(
                "Chat and dashboard ready",
                detail: "Opening \(claw)…",
                icon: "checkmark.circle")
        case let .reachable(hostname):
            self.heading("You’re all set!", subtitle: "Reachable at \(hostname).")
            self.row("Recovery kit saved", detail: "Keep it safe. New devices still need your approval.", icon: "key")
        }
    }

    private func heading(_ title: String, subtitle: String) -> some View {
        VStack(spacing: 10) {
            Text(title).font(.largeTitle.weight(.semibold))
            Text(subtitle).foregroundStyle(.secondary)
        }
    }

    private func row(_ title: String, detail: String, icon: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.title2).foregroundStyle(.tint).frame(width: 28)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .multilineTextAlignment(.leading)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func browserApproval(_ url: URL?) -> some View {
        if let url, url.scheme == "https" || (url.scheme == "http" && url.host() == "localhost") {
            Link("Alone at this Mac? Open Access in your browser", destination: url)
            Text("Sign in as the owner in your browser, then approve the matching request.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
