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
    @State private var recoveryCode = ""

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
            self.heading("Sign in with OpenClaw ID", subtitle: "Find the claws you own or were invited to.")
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
                        detail: "\(claw.relationship) · \(claw.online ? "Online" : "Offline — turn it on to continue")",
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
        case .signingIn:
            self.heading("Finish signing in", subtitle: "Continue in the OpenClaw ID window.")
            ProgressView().controlSize(.large)
            Text("This only confirms who you are. Access to a claw still needs your approval.")
                .font(.callout).foregroundStyle(.secondary)
        case let .chooseApproval(claw, device):
            self.heading(
                "Make this Mac your device",
                subtitle: "You own \(claw). Approve \(device) once to use it with full access.")
            self.choice(
                "Approve from another device",
                detail: "Use a browser or device that already has access to \(claw). You’ll compare a six-digit code.",
                icon: "laptopcomputer.and.iphone",
                action: .approveFromDevice)
            self.choice(
                "Use your recovery kit",
                detail: "For when no other device is at hand. The kit is used once on this Mac, then erased.",
                icon: "key",
                action: .useRecoveryKit)
            self.row(
                "\(device) will also run tools for \(claw)",
                detail: """
                Commands, screen, camera and notifications, subject to the permissions you grant. \
                You can stop this in Settings.
                """,
                icon: "wrench.and.screwdriver")
        case let .ownerCompareCode(claw, device, code, approvalURL):
            self.heading(
                "Compare the code",
                subtitle: "On a device that already has access to \(claw), open the request from \(device).")
            Text(code).font(.system(size: 42, weight: .semibold, design: .monospaced)).textSelection(.enabled)
            Text("Approve only if all six digits match.").foregroundStyle(.secondary)
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Waiting for approval…").foregroundStyle(.secondary)
            }
            self.note("""
            Look for the notification in \(claw)’s Control UI, or open Account → Your devices → \
            Approve a new device.
            """)
            if let approvalURL, approvalURL.scheme == "https" {
                Link(destination: approvalURL) { self.plain("Open \(claw) in your browser") }
            }
            Button("Use your recovery kit instead") { self.action(.useRecoveryKit) }.buttonStyle(.link)
        case let .recoveryKitEntry(claw):
            self.heading(
                "Use your recovery kit",
                subtitle: "Enter the recovery code from the kit you saved for \(claw).")
            SecureField("Recovery code", text: self.$recoveryCode)
                .textFieldStyle(.roundedBorder)
                .multilineTextAlignment(.leading)
            HStack {
                Button("Choose kit file…") { self.action(.chooseKitFile) }
                Spacer()
            }
            self.row(
                "Stays on this Mac",
                detail: """
                The code approves this Mac and then is erased from memory. It is never saved, \
                sent to \(claw) or logged.
                """,
                icon: "lock.shield")
            self.note("Your password manager saved it as “OpenClaw recovery kit · \(claw)”.", font: .caption)
            Button("Approve this Mac") {
                let code = self.recoveryCode
                self.recoveryCode = ""
                self.action(.submitRecoveryKit(code))
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.recoveryCode.isEmpty)
        case let .ownerConnected(claw, device, approvedWith):
            self.heading("You’re all set!", subtitle: "\(device) is your device on \(claw).")
            self.row(
                "Full access",
                detail: "Chat, dashboard and settings, like your browser. \(approvedWith).",
                icon: "checkmark.seal")
            self.row(
                "Runs tools for \(claw)",
                detail: "Your assistant can use this Mac within the permissions you grant. Stop anytime in Settings.",
                icon: "wrench.and.screwdriver")
            self.row(
                "Opening the dashboard…",
                detail: "Signed in through OpenClaw ID. No VPN or Gateway token.",
                icon: "rectangle.and.hand.point.up.left")
        case let .problem(problem):
            self.problemContent(problem)
        }
    }

    @ViewBuilder
    private func problemContent(_ problem: OnboardingOpenClawIDProblem) -> some View {
        switch problem {
        case let .clawOffline(claw):
            self.problemHeading(
                "\(claw) is offline",
                detail: """
                The computer running \(claw) isn’t reachable. Make sure it’s on and connected, \
                then try again.
                """,
                icon: "wifi.slash")
            Button("Try again") { self.action(.retry) }.buttonStyle(.borderedProminent)
            Button("Choose another claw") { self.action(.back) }.buttonStyle(.link)
        case let .denied(claw):
            self.problemHeading(
                "Not approved",
                detail: "The request to add this Mac to \(claw) was declined. Nothing was added.",
                icon: "xmark.octagon")
            Button("Start over") { self.action(.back) }.buttonStyle(.borderedProminent)
        case let .expired(claw):
            self.problemHeading(
                "The request expired",
                detail: "No one approved this Mac on \(claw) in time. Start again to get a new code.",
                icon: "clock.badge.exclamationmark")
            Button("Get a new code") { self.action(.retry) }.buttonStyle(.borderedProminent)
        case let .kitInvalid(claw):
            self.problemHeading(
                "That recovery code didn’t work",
                detail: "It isn’t a recovery code, or it’s the kit for another claw. Use the kit made for \(claw).",
                icon: "key.slash")
            Button("Try again") { self.action(.useRecoveryKit) }.buttonStyle(.borderedProminent)
            Button("Approve from another device instead") { self.action(.approveFromDevice) }
                .buttonStyle(.link)
        case let .notInvited(account):
            self.problemHeading(
                "No claws for \(account)",
                detail: """
                You don’t own a claw and haven’t joined one yet. Ask an owner for an invite, \
                or set up OpenClaw on this Mac.
                """,
                icon: "person.crop.circle.badge.questionmark")
        case let .memberNeedsInvite(claw):
            self.problemHeading(
                "Ask for an invite to \(claw)",
                detail: "You joined \(claw) as a member. Each of your devices joins with its own invite from an owner.",
                icon: "envelope.badge")
            Button("Choose another claw") { self.action(.back) }.buttonStyle(.link)
        case .signInFailed:
            self.problemHeading(
                "Sign-in didn’t finish",
                detail: "OpenClaw ID didn’t confirm your account. Try again.",
                icon: "person.crop.circle.badge.exclamationmark")
            Button("Sign in again") { self.action(.signIn) }.buttonStyle(.borderedProminent)
        }
    }

    /// Runtime text built from claw and device names (rendered as given, like `heading` and `row`).
    private func plain(_ text: String) -> Text {
        Text(text)
    }

    private func note(_ text: String, font: Font = .callout) -> some View {
        self.plain(text).font(font).foregroundStyle(.secondary)
    }

    private func problemHeading(_ title: String, detail: String, icon: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 44)).foregroundStyle(.orange)
            Text(title).font(.largeTitle.weight(.semibold))
            Text(detail).foregroundStyle(.secondary)
        }
    }

    private func choice(
        _ title: String,
        detail: String,
        icon: String,
        action: OnboardingOpenClawIDAction) -> some View
    {
        Button { self.action(action) } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon).font(.title2).foregroundStyle(.tint).frame(width: 28)
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.headline)
                    Text(detail).font(.callout).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }
            .multilineTextAlignment(.leading)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
