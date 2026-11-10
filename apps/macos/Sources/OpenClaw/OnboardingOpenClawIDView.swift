import SwiftUI

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
                action: { self.model.perform($0) })
                .disabled(self.model.busy || self.model.unavailableReason != nil)
            if self.model.busy { ProgressView("Working…") }
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
    let action: (OnboardingOpenClawIDAction) -> Void
    @State private var discoveryOrigin = ""

    var body: some View {
        VStack(spacing: 18) {
            self.content
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: 520)
    }

    @ViewBuilder
    private var content: some View {
        switch self.step {
        case .nodeInvitation:
            self.heading("Use a node invitation", subtitle: "Ask the owner for a private node invitation.")
            if let unavailableReason { Text(unavailableReason).foregroundStyle(.secondary) }
            Text("""
            Copy the private invitation, and enter the Discovery origin supplied by the owner. \
            Neither account sign-in nor a Gateway token is needed.
            """)
            .foregroundStyle(.secondary)
            TextField("Discovery origin (https://…)", text: self.$discoveryOrigin)
                .textFieldStyle(.roundedBorder)
            Button("Paste node invitation") {
                self.action(.pasteNodeInvitation(discoveryOrigin: self.discoveryOrigin))
            }
            .buttonStyle(.borderedProminent).disabled(self.discoveryOrigin.isEmpty)
            Text("""
            The private invitation is read only when you choose Paste. \
            It is not shown here or saved in preferences.
            """)
            .font(.caption).foregroundStyle(.secondary)
        case let .nodeConnection(claw, connected):
            self.heading(connected ? "Node connected" : "Node approved; connecting…", subtitle: claw)
            self.row(
                connected ? "Node connection verified" : "Waiting for the node connection",
                detail: connected ? "The Gateway completed this Mac’s node handshake." :
                    "Approval alone does not prove connectivity. Check again after the Mac connects.",
                icon: connected ? "checkmark.circle" : "hourglass")
            Text("Chat and account access are not configured by this invitation.")
                .foregroundStyle(.secondary)
            Button("Check connection") { self.action(.checkApproval) }
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
            self.heading("Add this Mac to \(claw)", subtitle: "Review this Mac’s requested node capabilities.")
            self.row(device, detail: "macOS · this device", icon: "laptopcomputer")
            ScrollView {
                self.row("Node capabilities", detail: capabilities, icon: "wrench.and.screwdriver")
            }
            .frame(maxHeight: 160)
            self.row(
                "Chat access stays separate",
                detail: """
                This node invitation does not sign you in, approve chat access, \
                or grant Gateway administration.
                """,
                icon: "bubble.left.and.bubble.right")
            Button("Request node access") { self.action(.requestNode) }.buttonStyle(.borderedProminent)
        case let .compareCode(claw, device, code, approvalURL):
            self.heading("Compare the code", subtitle: "On \(claw), open Access and find \(device).")
            Text(code).font(.system(size: 42, weight: .semibold, design: .monospaced)).textSelection(.enabled)
            Text("Approve node access only if the six digits match. This code does not approve chat access.")
                .foregroundStyle(.secondary)
            self.row("Waiting for node approval", detail: "Account and chat setup remain separate.", icon: "hourglass")
            self.browserApproval(approvalURL)
            Button("Check approval") { self.action(.checkApproval) }
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
            self.heading("You’re all set!", subtitle: "Connected to \(claw) through OpenClaw ID.")
            self.row(
                "Node connected",
                detail: "This Mac’s approved capabilities are available.",
                icon: "checkmark.circle")
            self.row(
                "Chat connected",
                detail: "Your separately approved operator access is ready.",
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
