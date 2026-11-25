import SwiftUI

/// First-run help for people who installed the app without an OpenClaw Gateway yet.
/// Onboarding offers it only while no Gateway has ever been saved on this device.
struct OnboardingNewUserGuideSheet: View {
    static let setupGuideURL = URL(string: "https://docs.openclaw.ai/start/getting-started#pair-your-iphone-or-ipad")!
    static let connectionHelpURL = URL(string: "https://docs.openclaw.ai/platforms/ios#quick-start-pair-+-connect")!

    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("First, set up OpenClaw on a computer")
                    .font(OpenClawType.title2)
                    .fixedSize(horizontal: false, vertical: true)

                Text("OpenClaw runs on a Mac, Windows or Linux computer you own. This app connects to it.")
                    .font(OpenClawType.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)

                VStack(alignment: .leading, spacing: 20) {
                    OnboardingNewUserGuideStep(
                        number: 1,
                        title: "Install OpenClaw",
                        detail: "The setup guide walks you through it.")
                    OnboardingNewUserGuideStep(
                        number: 2,
                        title: "Show a pairing code",
                        detail: """
                        On the computer, open Devices and choose Connect a device. \
                        Your phone needs a secure way to reach the computer first.
                        """)
                    OnboardingNewUserGuideStep(
                        number: 3,
                        title: "Scan it here",
                        detail: "Come back and tap Scan QR.")
                }
                .padding(.top, 26)

                Button {
                    self.openURL(Self.connectionHelpURL)
                } label: {
                    Text("Connection help")
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(OpenClawBrand.activationPrimaryAction)
                }
                .buttonStyle(.plain)
                .padding(.top, 18)

                VStack(spacing: 10) {
                    ShareLink(item: Self.setupGuideURL) {
                        Text("Send setup guide to my computer")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .buttonStyle(OpenClawPrimaryActionButtonStyle())

                    Button {
                        self.openURL(Self.setupGuideURL)
                    } label: {
                        Text("Open setup guide")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .buttonStyle(OpenClawSecondaryActionButtonStyle(height: 54))
                }
                .padding(.top, 36)
            }
            .padding(.horizontal, 22)
            .padding(.top, 28)
            .padding(.bottom, 24)
        }
        .presentationDragIndicator(.visible)
    }
}

private struct OnboardingNewUserGuideStep: View {
    let number: Int
    let title: LocalizedStringKey
    let detail: LocalizedStringKey

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text(verbatim: "\(self.number)")
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(OpenClawBrand.activationPrimaryAction)
                .frame(width: 30, height: 30)
                .background {
                    Circle()
                        .fill(OpenClawBrand.activationNeutralInsetSurface)
                }
                .overlay {
                    Circle()
                        .stroke(OpenClawBrand.activationNeutralStroke, lineWidth: 0.6)
                }
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(self.title)
                    .font(OpenClawType.subheadSemiBold)
                Text(self.detail)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
