import OpenClawChatUI
import OpenClawKit
import SwiftUI
import UniformTypeIdentifiers

/// First launch with OpenClaw ID: sign in, pick a claw, then approve this device. Every other way
/// to connect stays one tap away in the existing setup wizard.
struct OpenClawIDOnboardingView: View {
    @Bindable var model: OpenClawIDSetupModel
    let onOtherWays: () -> Void

    var body: some View {
        OnboardingActivationCanvas {
            VStack(alignment: .leading, spacing: 0) {
                OpenClawIDStepContent(
                    step: self.model.step,
                    busy: self.model.busy,
                    unavailableReason: self.model.step == .signIn
                        ? self.model.accountUnavailableReason : self.model.unavailableReason,
                    onOtherWays: self.onOtherWays,
                    action: { self.model.perform($0) })
                    .disabled(self.model.busy)

                if let error = self.model.error {
                    Text(verbatim: error)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(OpenClawBrand.statusWarning)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 14)
                    if self.model.step.isJoined {
                        Button { self.model.perform(.retry) } label: {
                            Text("Try again").font(OpenClawType.subheadSemiBold)
                        }
                        .buttonStyle(OpenClawSecondaryActionButtonStyle())
                        .padding(.top, 10)
                    }
                }
            }
        }
        .task { self.model.begin(.connect) }
        .onDisappear { self.model.cancel() }
    }
}

/// The presentation of one setup step; render fixtures use it without a service.
struct OpenClawIDStepContent: View {
    let step: OpenClawIDSetupStep
    var busy = false
    let unavailableReason: String?
    let onOtherWays: () -> Void
    let action: (OpenClawIDSetupAction) -> Void
    @State private var recoveryCode = ""
    @State private var choosingKitFile = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.content
        }
        .fileImporter(isPresented: self.$choosingKitFile, allowedContentTypes: [.plainText, .text, .data]) {
            guard case let .success(url) = $0, let code = Self.recoveryCode(in: url) else { return }
            self.action(.submitRecoveryKit(code))
        }
    }

    @ViewBuilder
    private var content: some View {
        switch self.step {
        case .signIn:
            OnboardingHeroHeader(
                title: "OpenClaw",
                subtitle: "Sign in to connect to your Claw.")
                .padding(.top, 18)
            OnboardingIntroPanel {
                VStack(alignment: .leading, spacing: 14) {
                    OnboardingSafetyRow(symbol: "person.crop.circle", title: "One account for all your claws")
                    OnboardingSafetyRow(
                        symbol: "checkmark.shield",
                        title: "Each claw still approves this device")
                    OnboardingSafetyRow(symbol: "lock", title: "End-to-end encrypted connection")
                }
            }
            .padding(.top, 32)
            Spacer(minLength: 32)
            if let unavailableReason {
                Text(verbatim: unavailableReason)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            }
            self.primary("Sign in with OpenClaw ID", action: .signIn)
                .disabled(self.unavailableReason != nil)
            self.otherWays
        case .signingIn:
            self.heading("Finish signing in", subtitle: "Continue in the OpenClaw ID sheet.", mood: .thinking)
            self.row(
                "This only confirms who you are",
                detail: "Access to a claw still needs your approval.",
                icon: "person.badge.shield.checkmark")
        case let .claws(account, claws):
            self.heading("Your claws", subtitle: "Signed in as \(account).")
            ForEach(claws) { claw in
                Button { self.action(.selectClaw(claw.id)) } label: {
                    self.card(
                        claw.name,
                        detail: "\(claw.relationship) · \(claw.online ? "Online" : "Offline — turn it on to continue")",
                        icon: claw.online ? "desktopcomputer" : "desktopcomputer.trianglebadge.exclamationmark",
                        chevron: true)
                }
                .buttonStyle(.plain)
                .disabled(!claw.online)
            }
            self.secondary("Join with an invite link", action: .joinWithInvite)
            self.link("Use a different account", action: .switchAccount)
        case let .chooseApproval(claw, device):
            self.heading("Approve this device", subtitle: "You own \(claw). Approve \(device) once.")
            self.choice(
                "Approve from another device",
                detail: "Use a computer or browser that already has access to \(claw). You’ll compare six digits.",
                icon: "laptopcomputer.and.iphone",
                action: .approveFromDevice)
            self.choice(
                "Use your recovery kit",
                detail: "For when no other device is at hand. The code is used once, then erased.",
                icon: "key",
                action: .useRecoveryKit)
            self.row(
                "Chat and the dashboard",
                detail: "Your assistant can’t use this device’s camera, location or notifications until you allow it.",
                icon: "bubble.left.and.bubble.right")
        case let .addMemberDevice(claw, device):
            self.heading(
                "Approve this device",
                subtitle: "You’re a member of \(claw). Approve \(device) from a device you already use with it.")
            self.choice(
                "Approve from another of your devices",
                detail: "Use a computer or browser that already has access to \(claw). You’ll compare six digits.",
                icon: "laptopcomputer.and.iphone",
                action: .approveFromDevice)
            self.link("Lost your other devices? Join with a new invite", action: .joinWithInvite)
        case let .deviceCompareCode(claw, device, code, approvalURL, confirmed, member):
            self.heading(
                "Compare the code",
                subtitle: member
                    ? "On another of your devices, open \(claw) and find the request from \(device)."
                    : "On a device that already has access to \(claw), open the request from \(device).")
            Text(verbatim: code)
                .font(OpenClawType.mono)
                .scaleEffect(2.2)
                .frame(maxWidth: .infinity, minHeight: 88)
                .textSelection(.enabled)
                .accessibilityLabel(Text(verbatim: code.map(String.init).joined(separator: " ")))
            if confirmed {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Waiting for approval…").font(OpenClawType.subhead).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
            } else {
                Text("Does the other device show the same six digits?")
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
                self.primary("The codes match", action: .confirmCode(matches: true))
                self.secondary("They don’t match", action: .confirmCode(matches: false))
            }
            if let approvalURL, approvalURL.scheme == "https" {
                Link(destination: approvalURL) {
                    Text(verbatim: "Open \(claw) in Safari")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
            }
            if member {
                self.link("Use an invite instead", action: .joinWithInvite)
            } else {
                self.link("Use your recovery kit instead", action: .useRecoveryKit)
            }
        case let .recoveryKitEntry(claw):
            self.heading(
                "Use your recovery kit",
                subtitle: "Enter the recovery code from the kit you saved for \(claw).")
            SecureField(text: self.$recoveryCode) {
                Text("Recovery code").font(OpenClawType.body)
            }
            .font(OpenClawType.mono)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .textContentType(.password)
            .padding(14)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityLabel(Text("Recovery code"))
            Button { self.choosingKitFile = true } label: {
                Text("Choose kit file…").font(OpenClawType.subheadSemiBold)
            }
            .buttonStyle(OpenClawSecondaryActionButtonStyle())
            self.row(
                "Stays on this device",
                detail: """
                The code approves this device and is then erased. \
                It is never saved, sent to \(claw) or logged.
                """,
                icon: "lock.shield")
            Button {
                let code = self.recoveryCode
                self.recoveryCode = ""
                self.action(.submitRecoveryKit(code))
            } label: {
                Text("Approve this device").font(OpenClawType.subheadSemiBold)
            }
            .buttonStyle(OpenClawPrimaryActionButtonStyle())
            .disabled(self.recoveryCode.isEmpty)
            self.link("Back", action: .back)
        case let .ownerConnected(claw, device, approvedWith):
            self.heading("You’re all set", subtitle: "\(device) is your device on \(claw).", mood: .celebrating)
            self.row("Full access", detail: "Chat, dashboard and settings. \(approvedWith).", icon: "checkmark.seal")
        case .inviteEntry:
            self.heading(
                "Join with an invite",
                subtitle: "Copy the invite link the owner sent you, then paste it here.")
            self.primary("Paste invite link", action: .pasteInvite)
            Text("The link is read only when you tap Paste. It isn’t shown here or saved.")
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
            self.link("Back", action: .back)
        case let .memberRequest(claw, device, account):
            self.heading("Join \(claw)?", subtitle: "You’re signed in as \(account).")
            self.row(device, detail: "This device", icon: "iphone")
            self.row(
                "An owner approves it",
                detail: "Your request goes to \(claw). You join once an owner approves it, with the access they chose.",
                icon: "person.badge.shield.checkmark")
            self.primary("Ask to join", action: .requestJoin)
            self.link("Back", action: .back)
        case let .memberPending(claw, device):
            self.heading(
                "Waiting for approval",
                subtitle: "An owner of \(claw) needs to approve \(device).",
                mood: .thinking)
            self.row(
                "You can close the app",
                detail: "Let the owner know you asked to join. Open OpenClaw again to finish joining.",
                icon: "bell")
            self.secondary("Check again", action: .retry)
            self.link("Cancel request", action: .cancelJoin)
        case let .memberConnected(claw, device, role):
            self.heading("You’re all set", subtitle: "\(device) joined \(claw).", mood: .celebrating)
            self.row(
                role.map { "Joined as \($0)" } ?? "Added to \(claw)",
                detail: "Chat and the dashboard, with the access the owner chose.",
                icon: "checkmark.seal")
        case let .problem(problem):
            self.problemContent(problem)
        case .nodeInvitation, .nodeConnection, .recoveryKit, .addDevice, .compareCode, .chatAccess, .connected,
             .reachable:
            // Node invitations and claw setup are not offered on this device.
            self.heading("Not available here", subtitle: "Use another way to connect.")
            self.otherWays
        }
    }

    @ViewBuilder
    private func problemContent(_ problem: OpenClawIDSetupProblem) -> some View {
        switch problem {
        case let .clawOffline(claw):
            self.problemHeading(
                "\(claw) is offline",
                detail: "The computer running \(claw) isn’t reachable. Make sure it’s on and connected.",
                icon: "wifi.slash")
            self.primary("Try again", action: .retry)
            self.link("Choose another claw", action: .back)
        case let .denied(claw):
            self.problemHeading(
                "Not approved",
                detail: "The request to add this device to \(claw) was declined. Nothing was added.",
                icon: "xmark.octagon")
            self.primary("Start over", action: .back)
        case let .expired(claw):
            self.problemHeading(
                "The request expired",
                detail: "No one approved this device on \(claw) in time.",
                icon: "clock.badge.exclamationmark")
            self.primary("Get a new code", action: .retry)
        case let .kitInvalid(claw):
            self.problemHeading(
                "That recovery code didn’t work",
                detail: "It isn’t a recovery code, or it’s the kit for another claw. Use the kit made for \(claw).",
                icon: "key.slash")
            self.primary("Try again", action: .useRecoveryKit)
            self.link("Approve from another device instead", action: .approveFromDevice)
        case let .notInvited(account):
            self.problemHeading(
                "No claws for \(account) yet",
                detail: "You don’t own a claw and haven’t joined one. Ask an owner for an invite.",
                icon: "person.crop.circle.badge.questionmark")
            self.primary("Join with an invite link", action: .joinWithInvite)
            self.otherWays
            self.link("Use a different account", action: .switchAccount)
        case .inviteInvalid:
            self.problemHeading(
                "That invite link didn’t work",
                detail: "Copy the whole link from the owner’s invite and try again, or ask them for a new one.",
                icon: "envelope.badge")
            self.primary("Try again", action: .joinWithInvite)
        case let .inviteExpired(claw):
            self.problemHeading(
                "The request expired",
                detail: "No owner of \(claw) approved this device within seven days.",
                icon: "clock.badge.exclamationmark")
            self.primary("Join with a new invite", action: .joinWithInvite)
        case .signInFailed:
            self.problemHeading(
                "Sign-in didn’t finish",
                detail: "OpenClaw ID didn’t confirm your account. Try again.",
                icon: "person.crop.circle.badge.exclamationmark")
            self.primary("Sign in again", action: .signIn)
            self.otherWays
        }
    }

    private var otherWays: some View {
        Button(action: self.onOtherWays) {
            Text("Other ways to connect")
                .font(OpenClawType.subheadSemiBold)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawBrand.activationPrimaryAction)
    }

    private func heading(_ title: String, subtitle: String, mood: OpenClawMascotMood = .idle) -> some View {
        OnboardingHeroHeader(
            title: LocalizedStringKey(title),
            subtitle: LocalizedStringKey(subtitle),
            mood: mood)
            .padding(.top, 18)
            .padding(.bottom, 12)
    }

    private func problemHeading(_ title: String, detail: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: icon).font(.system(size: 40)).foregroundStyle(OpenClawBrand.statusWarning)
            Text(verbatim: title).font(OpenClawType.title2SemiBold)
            Text(verbatim: detail).font(OpenClawType.subhead).foregroundStyle(.secondary)
        }
        .padding(.top, 40)
        .padding(.bottom, 16)
    }

    private func primary(_ title: String, action: OpenClawIDSetupAction) -> some View {
        Button { self.action(action) } label: {
            if self.busy {
                ProgressView().tint(OpenClawBrand.activationPrimaryActionText)
            } else {
                Text(verbatim: title).font(OpenClawType.subheadSemiBold)
            }
        }
        .buttonStyle(OpenClawPrimaryActionButtonStyle())
    }

    private func secondary(_ title: String, action: OpenClawIDSetupAction) -> some View {
        Button { self.action(action) } label: {
            Text(verbatim: title).font(OpenClawType.subheadSemiBold)
        }
        .buttonStyle(OpenClawSecondaryActionButtonStyle())
    }

    private func link(_ title: String, action: OpenClawIDSetupAction) -> some View {
        Button { self.action(action) } label: {
            Text(verbatim: title)
                .font(OpenClawType.subheadSemiBold)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawBrand.activationPrimaryAction)
    }

    private func choice(_ title: String, detail: String, icon: String, action: OpenClawIDSetupAction) -> some View {
        Button { self.action(action) } label: {
            self.card(title, detail: detail, icon: icon, chevron: true)
        }
        .buttonStyle(.plain)
    }

    private func row(_ title: String, detail: String, icon: String) -> some View {
        self.card(title, detail: detail, icon: icon, chevron: false)
    }

    private func card(_ title: String, detail: String, icon: String, chevron: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.title3).foregroundStyle(.tint).frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: title).font(OpenClawType.headline)
                Text(verbatim: detail).font(OpenClawType.footnote).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if chevron { Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
        }
        .multilineTextAlignment(.leading)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14))
        .contentShape(Rectangle())
    }

    /// The recovery code in a saved kit file, read once and not kept.
    static func recoveryCode(in url: URL) -> String? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let text = try? String(contentsOf: url, encoding: .utf8),
              let range = text.range(of: "OCK1(-?[0-9A-Za-z]){31}", options: .regularExpression)
        else { return nil }
        return String(text[range])
    }
}
