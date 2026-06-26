import SwiftUI
import UIKit

struct OnboardingIntroStep: View {
    let onContinue: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            OpenClawProMark(size: 64, shadowRadius: 14)
                .padding(.bottom, 18)

            Text("Welcome to OpenClaw")
                .font(.largeTitle.weight(.bold))
                .multilineTextAlignment(.center)
                .padding(.bottom, 10)

            Text("Connect this device to an OpenClaw Gateway for chat, voice, camera, and device tools.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .padding(.bottom, 24)

            VStack(alignment: .leading, spacing: 14) {
                Label("Connect to your Gateway", systemImage: "link")
                Label("Choose device permissions", systemImage: "hand.raised")
                Label("Use OpenClaw from your phone", systemImage: "message.fill")
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemBackground))
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 16)

            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(OpenClawBrand.warn)
                    .frame(width: 24)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Security notice")
                        .font(.headline)
                    Text(
                        "The connected OpenClaw agent can use device capabilities you enable, "
                            + "such as camera, microphone, photos, contacts, calendar, and location. "
                            + "Continue only if you trust the gateway and agent you connect to.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemBackground))
            }
            .padding(.horizontal, 24)

            Spacer()

            Button {
                self.onContinue()
            } label: {
                Text("Continue")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal, 24)
            .padding(.bottom, 48)
        }
    }
}

struct OnboardingWelcomeStep: View {
    let onConnectGateway: () -> Void
    let onExploreOpenClaw: () -> Void
    let onSetupGateway: () -> Void

    var body: some View {
        ZStack {
            OpenClawProBackground()

            ScrollView {
                VStack(spacing: 0) {
                    MoltyWelcomeMark()
                        .padding(.top, 36)
                        .padding(.bottom, 18)

                    Text("OpenClaw on your phone")
                        .font(.largeTitle.weight(.bold))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                        .padding(.bottom, 8)

                    OnboardingGatewayExplainer()
                        .padding(.horizontal, 24)
                        .padding(.top, 8)

                    VStack(spacing: 0) {
                        OnboardingChoiceButton(
                            title: "Explore a preview",
                            subtitle: "Open a sample workspace and tap around before setup.",
                            systemImage: "rectangle.stack.fill",
                            iconColor: OpenClawBrand.info,
                            action: self.onExploreOpenClaw)

                        OnboardingChoiceDivider()

                        OnboardingChoiceButton(
                            title: "Set up OpenClaw",
                            subtitle: "Install a Gateway and pair this phone.",
                            systemImage: "desktopcomputer",
                            iconColor: OpenClawBrand.warn,
                            action: self.onSetupGateway)

                        OnboardingChoiceDivider()

                        OnboardingChoiceButton(
                            title: "Enter a setup code",
                            subtitle: "Scan a QR code or paste an existing setup code.",
                            systemImage: "qrcode.viewfinder",
                            iconColor: OpenClawBrand.accent,
                            action: self.onConnectGateway)
                    }
                    .background {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(Color(uiColor: .secondarySystemGroupedBackground))
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 22)

                    Text(
                        "Preview uses sample data. Pair a Gateway when you're ready to run real agents and actions.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .lineSpacing(2)
                        .padding(.horizontal, 28)
                        .padding(.top, 18)
                        .padding(.bottom, 34)
                }
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
        }
    }
}

private struct MoltyWelcomeMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var frameIndex = 0

    private static let waveFrames = [
        "MoltyWelcomeWave0",
        "MoltyWelcomeWave1",
        "MoltyWelcomeWave2",
        "MoltyWelcomeWave3",
    ]
    private static let waveSequence = [1, 2, 3, 0]

    var body: some View {
        ZStack {
            ForEach(Array(Self.waveFrames.enumerated()), id: \.offset) { index, frameName in
                Image(frameName)
                    .resizable()
                    .scaledToFit()
                    .opacity(index == self.frameIndex ? 1 : 0)
            }
        }
        .frame(width: 76, height: 82)
        .animation(nil, value: self.frameIndex)
        .shadow(color: OpenClawBrand.accent.opacity(0.18), radius: 14, y: 5)
        .accessibilityLabel("OpenClaw")
        .task(id: self.reduceMotion) {
            guard !self.reduceMotion else {
                self.frameIndex = 0
                return
            }
            await self.runWaveLoop()
        }
    }

    @MainActor
    private func runWaveLoop() async {
        self.frameIndex = 0

        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 3_200_000_000)
            guard !Task.isCancelled else { return }

            for index in Self.waveSequence {
                self.frameIndex = index
                try? await Task.sleep(nanoseconds: 115_000_000)
                guard !Task.isCancelled else { return }
            }
        }
    }
}

struct OnboardingGatewaySetupStep: View {
    @State private var platform: GatewaySetupPlatform = .mac
    @State private var commandCopyFeedback: String?

    let onConnectGateway: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Set up OpenClaw")
                            .font(.largeTitle.weight(.bold))
                        OnboardingSupportText(
                            "Install OpenClaw on the computer or server that will run your Gateway. "
                                + "Then pair this phone with the QR or setup code.")
                    }
                    .padding(.top, 4)

                    GatewaySetupNoteCard()

                    Picker("Gateway platform", selection: self.$platform) {
                        ForEach(GatewaySetupPlatform.allCases) { item in
                            Text(item.title).tag(item)
                        }
                    }
                    .pickerStyle(.segmented)

                    VStack(alignment: .leading, spacing: 13) {
                        ForEach(Array(self.platform.steps.enumerated()), id: \.offset) { index, step in
                            GatewaySetupStepRow(index: index + 1, title: step)
                        }
                    }
                    .padding(14)
                    .proPanelSurface(tint: OpenClawBrand.accent, radius: 12, isProminent: true)

                    VStack(alignment: .leading, spacing: 10) {
                        Text(self.platform.commandTitle)
                            .font(.headline)
                        OnboardingSupportText("Run this on the device that will host your Gateway.", font: .caption)
                        Text(self.platform.command)
                            .font(.system(.footnote, design: .monospaced).weight(.semibold))
                            .textSelection(.enabled)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(Color(uiColor: .tertiarySystemBackground))
                            }
                        OnboardingSupportText("When setup shows a pairing code, continue below.", font: .footnote)

                        HStack(spacing: 10) {
                            Button {
                                UIPasteboard.general.string = self.platform.command
                                self.commandCopyFeedback = "Copied command"
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)

                            ShareLink(
                                item: self.platform.shareText,
                                subject: Text("Set up OpenClaw"),
                                preview: SharePreview("Set up OpenClaw"))
                            {
                                Label("Share", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }

                        if let commandCopyFeedback {
                            Text(commandCopyFeedback)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(OpenClawBrand.accent)
                                .transition(.opacity)
                        }
                    }
                    .padding(14)
                    .proPanelSurface(radius: 12)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("After pairing")
                            .font(.headline)
                        VStack(alignment: .leading, spacing: 8) {
                            GatewayUnlockRow(icon: "person.2.fill", title: "Real chats and agents")
                            GatewayUnlockRow(
                                icon: "hammer.fill",
                                title: "Tools, skills, approvals, and schedules")
                            GatewayUnlockRow(icon: "macwindow", title: "Your machines and sessions")
                        }
                    }
                    .padding(14)
                    .proPanelSurface(radius: 12)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 72)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity, alignment: .center)
            }

            VStack(spacing: 0) {
                Divider()
                    .opacity(0.08)

                Button {
                    self.onConnectGateway()
                } label: {
                    Text("I Have a Setup Code")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.horizontal, 24)
                .padding(.top, 10)
                .padding(.bottom, 16)
            }
            .background(.regularMaterial)
        }
        .onChange(of: self.platform) { _, _ in
            self.commandCopyFeedback = nil
        }
    }
}

private struct OnboardingGatewayExplainer: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ProIconBadge(systemName: "network", color: OpenClawBrand.info)

            VStack(alignment: .leading, spacing: 3) {
                Text("Mobile connects to your Gateway")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.primary)
                OnboardingSupportText(
                    "OpenClaw runs on a computer or server. The mobile app connects to that Gateway "
                        + "for agents, tools, and approvals.",
                    font: .footnote)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(uiColor: .secondarySystemGroupedBackground).opacity(0.72))
        }
    }
}

private struct GatewaySetupNoteCard: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ProIconBadge(systemName: "network", color: OpenClawBrand.info)

            VStack(alignment: .leading, spacing: 4) {
                Text("Gateway runs the work")
                    .font(.subheadline.weight(.semibold))
                OnboardingSupportText(
                    "Mobile stays lightweight. Agents, tools, approvals, and schedules run through your Gateway.",
                    font: .footnote)
            }
        }
        .padding(14)
        .proPanelSurface(tint: OpenClawBrand.info, radius: 12)
    }
}

private struct OnboardingChoiceDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color(uiColor: .separator).opacity(0.18))
            .frame(height: 1 / UIScreen.main.scale)
            .padding(.leading, 58)
    }
}

private struct OnboardingChoiceButton: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let iconColor: Color
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack(alignment: .top, spacing: 14) {
                ProIconBadge(
                    systemName: self.systemImage,
                    color: self.iconColor)

                VStack(alignment: .leading, spacing: 4) {
                    Text(self.title)
                        .font(.subheadline.weight(.semibold))
                    Text(self.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineSpacing(1)
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(.primary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct GatewaySetupStepRow: View {
    let index: Int
    let title: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(self.index)")
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(OpenClawBrand.accent, in: Circle())
            Text(self.title)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct GatewayUnlockRow: View {
    let icon: String
    let title: String

    var body: some View {
        Label {
            Text(self.title)
                .font(.footnote)
                .foregroundStyle(.secondary)
        } icon: {
            Image(systemName: self.icon)
                .foregroundStyle(OpenClawBrand.accent)
        }
    }
}

private struct OnboardingSupportText: View {
    let text: String
    let font: Font

    init(_ text: String, font: Font = .subheadline) {
        self.text = text
        self.font = font
    }

    var body: some View {
        Text(self.text)
            .font(self.font)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private enum GatewaySetupPlatform: String, CaseIterable, Identifiable {
    case mac
    case windows
    case linux
    case server

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .mac: "Mac"
        case .windows: "Windows"
        case .linux: "Linux"
        case .server: "Server"
        }
    }

    var steps: [String] {
        switch self {
        case .mac:
            [
                "Install OpenClaw on your Mac.",
                "Start the Gateway.",
                "Generate a mobile pairing code.",
            ]
        case .windows:
            [
                "Install OpenClaw with PowerShell or Windows Hub.",
                "Start the Gateway.",
                "Generate a mobile pairing code.",
            ]
        case .linux:
            [
                "Install OpenClaw on Linux or WSL2.",
                "Start the Gateway.",
                "Generate a mobile pairing code.",
            ]
        case .server:
            [
                "Install OpenClaw on a reachable server.",
                "Expose it to this phone.",
                "Generate a remote pairing code.",
            ]
        }
    }

    var commandTitle: String {
        switch self {
        case .windows:
            "PowerShell install"
        case .server:
            "Server install"
        default:
            "Terminal install"
        }
    }

    var command: String {
        switch self {
        case .windows:
            "iwr -useb https://openclaw.ai/install.ps1 | iex"
        case .server:
            "curl -fsSL https://openclaw.ai/install.sh | bash"
        default:
            "curl -fsSL https://openclaw.ai/install.sh | bash"
        }
    }

    var shareText: String {
        [
            "Install OpenClaw on \(self.title):",
            "",
            self.command,
            "",
            "Then generate a mobile pairing code:",
            "",
            "openclaw qr",
            "",
            "Open the mobile app and scan or paste the code.",
        ].joined(separator: "\n")
    }
}

struct OnboardingModeRow: View {
    let title: String
    let subtitle: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.title)
                        .font(.body.weight(.semibold))
                    Text(self.subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: self.selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(self.selected ? OpenClawBrand.accent : Color.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
