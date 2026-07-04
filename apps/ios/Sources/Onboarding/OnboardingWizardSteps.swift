import SwiftUI

private enum OnboardingLayout {
    static let contentMaxWidth: CGFloat = 680
}

struct OnboardingIntroStep: View {
    let onContinue: () -> Void

    private static let features: [(icon: String, title: String, detail: String)] = [
        ("link", "Connect your gateway", "Pair with a quick QR scan."),
        ("hand.raised.fill", "You choose permissions", "Grant only the tools you want."),
        ("bubble.left.and.bubble.right.fill", "Chat, voice, and camera", "All from your phone."),
    ]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 0) {
                    OpenClawProMark(size: 76, shadowRadius: 12)
                        .padding(.top, 32)
                        .padding(.bottom, 20)

                    Text("Welcome to OpenClaw")
                        .font(OpenClawType.title1)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                        .padding(.bottom, 40)

                    VStack(alignment: .leading, spacing: 28) {
                        ForEach(Array(Self.features.enumerated()), id: \.offset) { _, feature in
                            OnboardingFeatureRow(icon: feature.icon, title: feature.title, detail: feature.detail)
                        }

                        GroupBox {
                            Text(
                                "The connected agent can use capabilities you enable, including camera, "
                                    + "microphone, photos, contacts, calendar, and location. Continue only if "
                                    + "you trust the gateway and agent.")
                                .font(OpenClawType.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        } label: {
                            Label("Security", systemImage: "lock.shield.fill")
                                .font(OpenClawType.headline)
                        }
                        .tint(OpenClawBrand.warn)
                    }
                    .padding(.horizontal, 12)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 20)
            }
            .scrollBounceBehavior(.basedOnSize)

            VStack(spacing: 16) {
                Text("You can change permissions later in Settings.")
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)

                Button(action: self.onContinue) {
                    Text("Continue")
                        .font(OpenClawType.headline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(OpenClawBrand.accent)
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 16)
        }
        .frame(maxWidth: OnboardingLayout.contentMaxWidth)
        .frame(maxWidth: .infinity)
    }
}

/// Inline command styled like a keyboard key so shell/chat commands stand out from prose.
struct KeycapText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(self.text)
            .font(OpenClawType.monoFootnote)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemFill))
                    .overlay {
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .strokeBorder(Color(uiColor: .separator).opacity(0.6), lineWidth: 0.5)
                    }
            }
    }
}

private struct OnboardingFeatureRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: self.icon)
                .font(OpenClawType.title2)
                .foregroundStyle(OpenClawBrand.accent)
                .frame(width: 34, alignment: .center)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(self.title)
                    .font(OpenClawType.headline)
                Text(self.detail)
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct OnboardingWelcomeStep: View {
    let statusLine: String
    let onScanQRCode: () -> Void
    let onManualSetup: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Image(systemName: "qrcode.viewfinder")
                .font(.system(size: 64))
                .foregroundStyle(OpenClawBrand.accent)
                .padding(.bottom, 24)

            Text("Connect Gateway")
                .font(OpenClawType.title1)
                .padding(.bottom, 12)

            KeycapText("/pair qr")
                .padding(.bottom, 10)

            Text("Run this in your OpenClaw chat, then scan the code.")
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            Spacer()

            VStack(spacing: 4) {
                Button {
                    self.onScanQRCode()
                } label: {
                    Label("Scan QR Code", systemImage: "qrcode")
                        .font(OpenClawType.headline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(OpenClawBrand.accent)

                Button(action: self.onManualSetup) {
                    Text("Set Up Manually")
                        .font(OpenClawType.headline)
                }
                .buttonStyle(.borderless)
                .controlSize(.large)
                .tint(OpenClawBrand.accent)
                .padding(.top, 12)
            }
            .padding(.horizontal, OpenClawSpacing.space6)
            .padding(.bottom, 12)

            if !self.statusLine.isEmpty {
                Text(self.statusLine)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }

            Color.clear.frame(height: 12)
        }
        .frame(maxWidth: OnboardingLayout.contentMaxWidth)
        .frame(maxWidth: .infinity)
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
                        .font(OpenClawType.headline)
                    Text(self.subtitle)
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: self.selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(self.selected ? OpenClawBrand.accent : Color.secondary)
            }
            .contentShape(Rectangle())
        }
        .font(OpenClawType.subhead)
        .buttonStyle(.plain)
    }
}
