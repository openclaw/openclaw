import SwiftUI
import UIKit

private enum OnboardingVisual {
    static let maxWidth: CGFloat = 430
}

private struct OnboardingActivationCanvas<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                self.content
                    .frame(maxWidth: OnboardingVisual.maxWidth)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: max(0, proxy.size.height - 94), alignment: .top)
                    .padding(.horizontal, 20)
                    .padding(.top, 54)
                    .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .background(OpenClawBrand.activationCanvasGradient.ignoresSafeArea())
        }
    }
}

private struct OnboardingHeroGlyph: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        Image("OpenClawIcon")
            .resizable()
            .scaledToFit()
            .frame(width: 78, height: 78)
            .opacity(self.appeared ? 1 : 0)
            .scaleEffect(self.reduceMotion ? 1 : (self.appeared ? 1 : 0.96))
            .animation(
                self.reduceMotion ? .easeOut(duration: 0.12) : .smooth(duration: 0.22),
                value: self.appeared)
            .onAppear {
                self.appeared = true
            }
            .accessibilityHidden(true)
    }
}

private struct OnboardingHeroHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 18) {
            OnboardingHeroGlyph()

            VStack(spacing: 8) {
                Text(self.title)
                    .font(.system(.largeTitle, design: .default).weight(.bold))
                    .multilineTextAlignment(.center)

                Text(self.subtitle)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

private typealias OnboardingPrimaryButtonStyle = OpenClawPrimaryActionButtonStyle
private typealias OnboardingTertiaryButtonStyle = OpenClawTertiaryActionButtonStyle

private enum OnboardingIntroPanelStyle {
    static let iconSize: CGFloat = 34
    static let contentSpacing: CGFloat = 12
    static let panelPadding: CGFloat = 16
    static let panelCornerRadius: CGFloat = 22

    static let panelFill = OpenClawBrand.activationNeutralSurface
    static let iconFill = OpenClawBrand.activationNeutralInsetSurface
    static let stroke = OpenClawBrand.activationNeutralStroke
}

private struct OnboardingIntroPanel<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        self.content
            .padding(Self.panelPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: OnboardingIntroPanelStyle.panelCornerRadius, style: .continuous)
                    .fill(OnboardingIntroPanelStyle.panelFill)
            }
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: OnboardingIntroPanelStyle.panelCornerRadius, style: .continuous)
                    .stroke(Color.white.opacity(0.42), lineWidth: 0.5)
                    .blendMode(.plusLighter)
            }
            .overlay {
                RoundedRectangle(cornerRadius: OnboardingIntroPanelStyle.panelCornerRadius, style: .continuous)
                    .stroke(OnboardingIntroPanelStyle.stroke, lineWidth: 0.5)
            }
    }

    private static var panelPadding: CGFloat {
        OnboardingIntroPanelStyle.panelPadding
    }
}

private struct OnboardingIntroIcon: View {
    let symbol: String
    let tint: Color

    var body: some View {
        Image(systemName: self.symbol)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(self.tint)
            .frame(
                width: OnboardingIntroPanelStyle.iconSize,
                height: OnboardingIntroPanelStyle.iconSize)
            .background {
                Circle()
                    .fill(OnboardingIntroPanelStyle.iconFill)
            }
            .overlay {
                Circle()
                    .stroke(OnboardingIntroPanelStyle.stroke, lineWidth: 0.6)
            }
    }
}

private struct OnboardingSafetyRow: View {
    let symbol: String
    let title: String

    var body: some View {
        HStack(spacing: OnboardingIntroPanelStyle.contentSpacing) {
            OnboardingIntroIcon(
                symbol: self.symbol,
                tint: OpenClawBrand.activationPrimaryAction)

            Text(self.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct OnboardingSecurityNotice: View {
    var body: some View {
        OnboardingIntroPanel {
            HStack(alignment: .top, spacing: OnboardingIntroPanelStyle.contentSpacing) {
                OnboardingIntroIcon(
                    symbol: "exclamationmark.triangle.fill",
                    tint: OpenClawBrand.warn)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Security notice")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(
                        "The connected OpenClaw agent can use device capabilities you enable, "
                            + "such as camera, microphone, photos, contacts, calendar, and location. "
                            + "Continue only if you trust the gateway and agent you connect to.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct OnboardingStepLabel: View {
    let number: Int
    let title: String

    var body: some View {
        HStack(spacing: 7) {
            Text("\(self.number).")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(OpenClawBrand.activationPrimaryAction)
            Text(self.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct OnboardingCommandChip: View {
    @State private var didCopy = false

    var body: some View {
        HStack(spacing: 8) {
            Text("/pair qr")
                .font(.system(.title3, design: .monospaced).weight(.semibold))
                .textSelection(.enabled)
            Spacer(minLength: 0)
            Button {
                self.copyCommand()
            } label: {
                Image(systemName: self.didCopy ? "checkmark" : "doc.on.doc")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(
                        self.didCopy ? OpenClawBrand.activationPrimaryAction : Color.secondary.opacity(0.56))
                    .frame(width: 38, height: 38)
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.plain)
            .contentShape(Rectangle())
            .accessibilityLabel("Copy pair command")
            .accessibilityValue(self.didCopy ? "Copied" : "/pair qr")
        }
        .foregroundStyle(OpenClawBrand.activationPrimaryAction)
        .padding(.vertical, 14)
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(OpenClawBrand.activationNeutralSurface)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(OpenClawBrand.activationNeutralStroke, lineWidth: 0.5)
        }
    }

    private func copyCommand() {
        UIPasteboard.general.string = "/pair qr"
        withAnimation(.smooth(duration: 0.14)) {
            self.didCopy = true
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_100_000_000)
            withAnimation(.smooth(duration: 0.16)) {
                self.didCopy = false
            }
        }
    }
}

struct OnboardingIntroStep: View {
    let onContinue: () -> Void

    var body: some View {
        OnboardingActivationCanvas {
            VStack(alignment: .leading, spacing: 0) {
                OnboardingHeroHeader(
                    title: "OpenClaw",
                    subtitle: "Securely connect this iPhone to your gateway.")
                    .padding(.top, 18)

                OnboardingIntroPanel {
                    VStack(alignment: .leading, spacing: 14) {
                        OnboardingSafetyRow(
                            symbol: "link",
                            title: "Connect to your gateway")
                        OnboardingSafetyRow(
                            symbol: "hand.raised",
                            title: "Choose device permissions")
                        OnboardingSafetyRow(
                            symbol: "message.fill",
                            title: "Use OpenClaw from your phone")
                    }
                }
                .padding(.top, 44)

                OnboardingSecurityNotice()
                    .padding(.top, 18)

                Spacer(minLength: 40)

                VStack(spacing: 14) {
                    Button {
                        self.onContinue()
                    } label: {
                        Text("Continue")
                    }
                    .buttonStyle(OnboardingPrimaryButtonStyle())
                }
            }
        }
    }
}

struct OnboardingWelcomeStep: View {
    let statusLine: String
    let isConnecting: Bool
    let onScanQRCode: () -> Void
    let onManualSetup: () -> Void

    var body: some View {
        let statusText = self.statusLine.trimmingCharacters(in: .whitespacesAndNewlines)

        OnboardingActivationCanvas {
            VStack(alignment: .leading, spacing: 0) {
                OnboardingHeroHeader(
                    title: "Connect Gateway",
                    subtitle: "Run this in OpenClaw, then scan.")
                    .padding(.top, 18)

                VStack(alignment: .leading, spacing: 12) {
                    OnboardingStepLabel(number: 1, title: "Run this in OpenClaw")
                    OnboardingCommandChip()
                }
                .padding(.top, 44)

                VStack(alignment: .leading, spacing: 12) {
                    OnboardingStepLabel(number: 2, title: "Scan QR")

                    Button(action: self.onScanQRCode) {
                        if self.isConnecting {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .progressViewStyle(.circular)
                                    .tint(OpenClawBrand.activationPrimaryActionText)
                                Text("Connecting…")
                            }
                        } else {
                            Label("Open camera", systemImage: "qrcode.viewfinder")
                        }
                    }
                    .buttonStyle(OnboardingPrimaryButtonStyle())
                    .disabled(self.isConnecting)
                }
                .padding(.top, 34)

                if !statusText.isEmpty {
                    Text(statusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 6)
                        .padding(.top, 14)
                        .transition(.opacity)
                }

                Spacer(minLength: 40)

                Button {
                    self.onManualSetup()
                } label: {
                    Text("QR not working?")
                }
                .buttonStyle(OnboardingTertiaryButtonStyle())
                .disabled(self.isConnecting)
            }
            .animation(.smooth(duration: 0.18), value: statusText)
        }
    }
}

struct OnboardingSuccessStep: View {
    let gatewayName: String
    let gatewayAddress: String?
    let onGetStarted: () -> Void

    var body: some View {
        OnboardingActivationCanvas {
            VStack(spacing: 0) {
                Spacer(minLength: 54)

                ZStack(alignment: .bottomTrailing) {
                    Image("OpenClawIcon")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 86, height: 86)
                        .shadow(color: OpenClawBrand.activationGlow.opacity(0.18), radius: 12, x: 0, y: 6)

                    Image(systemName: "checkmark")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 30, height: 30)
                        .background {
                            Circle()
                                .fill(OpenClawBrand.ok)
                        }
                        .overlay {
                            Circle()
                                .stroke(OpenClawBrand.activationCanvas, lineWidth: 3)
                        }
                }
                .padding(.bottom, 22)

                Text("You're connected")
                    .font(.system(.largeTitle, design: .default).weight(.bold))
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 8)

                Text(self.gatewayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                if let gatewayAddress, !gatewayAddress.isEmpty {
                    Text(gatewayAddress)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.top, 4)
                }

                Spacer(minLength: 40)

                Button {
                    self.onGetStarted()
                } label: {
                    Text("Get started")
                }
                .buttonStyle(OnboardingPrimaryButtonStyle())
            }
        }
    }
}

struct OnboardingModeIcon: View {
    let symbol: String
    let selected: Bool

    var body: some View {
        Image(systemName: self.symbol)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(self.selected ? OpenClawBrand.activationPrimaryActionText : .secondary)
            .frame(width: 34, height: 34)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(self.selected ? OpenClawBrand.activationPrimaryGradient : OpenClawBrand
                        .activationNeutralGradient)
                    .shadow(
                        color: self.selected ? OpenClawBrand.activationGlow.opacity(0.18) : .clear,
                        radius: 5,
                        x: 0,
                        y: 2)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(
                        self.selected ? Color.white.opacity(0.30) : OpenClawBrand.activationNeutralStroke,
                        lineWidth: 0.5)
            }
    }
}

struct OnboardingModeRow: View {
    let title: String
    let subtitle: String
    let symbol: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 12) {
                OnboardingModeIcon(symbol: self.symbol, selected: self.selected)

                VStack(alignment: .leading, spacing: 2) {
                    Text(self.title)
                        .font(.body.weight(.semibold))
                    Text(self.subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: self.selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(
                        self.selected ? OpenClawBrand.activationPrimaryAction : Color.secondary.opacity(0.46))
            }
            .padding(.vertical, 6)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
