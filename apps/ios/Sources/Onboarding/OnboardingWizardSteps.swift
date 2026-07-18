import OpenClawChatUI
import SwiftUI

private enum OnboardingVisual {
    static let maxWidth: CGFloat = 430
}

struct OnboardingActivationCanvas<Content: View>: View {
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
    var mood: OpenClawMascotMood = .idle

    var body: some View {
        OpenClawActivationGlyph(size: 78, mood: self.mood, interactive: true)
    }
}

struct OnboardingHeroHeader: View {
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey?
    var mood: OpenClawMascotMood = .idle

    var body: some View {
        VStack(spacing: 18) {
            OnboardingHeroGlyph(mood: self.mood)

            VStack(spacing: 8) {
                Text(self.title)
                    .font(OpenClawType.title1)
                    .multilineTextAlignment(.center)

                if let subtitle {
                    Text(subtitle)
                        .font(OpenClawType.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

private typealias OnboardingPrimaryButtonStyle = OpenClawPrimaryActionButtonStyle

private enum OnboardingIntroPanelStyle {
    static let iconSize: CGFloat = 34
    static let contentSpacing: CGFloat = 12
    static let panelPadding: CGFloat = 16
    static let panelCornerRadius: CGFloat = 22

    static let panelFill = OpenClawBrand.activationNeutralSurface
    static let iconFill = OpenClawBrand.activationNeutralInsetSurface
    static let stroke = OpenClawBrand.activationNeutralStroke
}

struct OnboardingIntroPanel<Content: View>: View {
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
            .font(OpenClawType.subheadSemiBold)
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
    let title: LocalizedStringKey

    var body: some View {
        HStack(spacing: OnboardingIntroPanelStyle.contentSpacing) {
            OnboardingIntroIcon(
                symbol: self.symbol,
                tint: OpenClawBrand.activationPrimaryAction)

            Text(self.title)
                .font(OpenClawType.subheadSemiBold)
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
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(.primary)
                    (
                        Text("The connected OpenClaw agent can use device capabilities you enable.")
                            + Text(verbatim: " ")
                            + Text(
                                "Camera, microphone, photos, contacts, calendar, and location may be available.")
                            + Text(verbatim: " ")
                            + Text(
                                "Continue only if you trust the gateway and agent you connect to."))
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct OnboardingIntroStep: View {
    let onContinue: () -> Void

    var body: some View {
        OnboardingActivationCanvas {
            VStack(alignment: .leading, spacing: 0) {
                OnboardingHeroHeader(
                    title: "OpenClaw",
                    subtitle: "Your agent, in your pocket. Pair this iPhone with your gateway to get started.")
                    .padding(.top, 18)

                OnboardingIntroPanel {
                    VStack(alignment: .leading, spacing: 14) {
                        OnboardingSafetyRow(
                            symbol: "desktopcomputer",
                            title: "Your agent runs on your own computer")
                        OnboardingSafetyRow(
                            symbol: "qrcode.viewfinder",
                            title: "Pair this iPhone by scanning a setup code")
                        OnboardingSafetyRow(
                            symbol: "message.fill",
                            title: "Chat, talk, and approve actions from anywhere")
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
                            .font(OpenClawType.subheadSemiBold)
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
        ReferencePairingView(
            statusLine: self.statusLine,
            isConnecting: self.isConnecting,
            scan: self.onScanQRCode,
            manual: self.onManualSetup)
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
                    OpenClawActivationGlyph(size: 86, mood: .celebrating, interactive: true)
                        .shadow(color: OpenClawBrand.activationGlow.opacity(0.18), radius: 12, x: 0, y: 6)

                    Image(systemName: "checkmark")
                        .font(OpenClawType.headlineBold)
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
                    .font(OpenClawType.title1)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 8)

                Text(verbatim: self.gatewayName)
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                if let gatewayAddress, !gatewayAddress.isEmpty {
                    Text(verbatim: gatewayAddress)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.top, 4)
                }

                Spacer(minLength: 40)

                Button {
                    self.onGetStarted()
                } label: {
                    Label("Go to Chat", systemImage: "bubble.left.and.bubble.right.fill")
                        .font(OpenClawType.subheadSemiBold)
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
            .font(OpenClawType.subheadSemiBold)
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
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey
    let symbol: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 12) {
                OnboardingModeIcon(symbol: self.symbol, selected: self.selected)

                VStack(alignment: .leading, spacing: 2) {
                    Text(self.title)
                        .font(OpenClawType.subheadSemiBold)
                    Text(self.subtitle)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: self.selected ? "checkmark.circle.fill" : "circle")
                    .font(self.selected ? .title3.weight(.semibold) : .title3.weight(.regular))
                    .foregroundStyle(
                        self.selected
                            ? OpenClawBrand.activationPrimaryAction
                            : Color(uiColor: .quaternaryLabel).opacity(0.55))
            }
            .padding(.vertical, 6)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
