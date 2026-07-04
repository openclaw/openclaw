import SwiftUI

struct OnboardingIntroStep: View {
    let onContinue: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            OpenClawProMark(size: 64, shadowRadius: 14)
                .padding(.bottom, 18)

            Text("Welcome to OpenClaw")
                .font(OpenClawType.title1)
                .foregroundStyle(OpenClawBrand.textPrimary)
                .multilineTextAlignment(.center)
                .padding(.bottom, 10)

            Text("Turn this device into a secure OpenClaw node for chat, voice, camera, and device tools.")
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, OpenClawSpacing.space8)
                .padding(.bottom, 24)

            VStack(alignment: .leading, spacing: 14) {
                Label("Connect to your gateway", systemImage: "link")
                    .font(OpenClawType.subheadSemiBold)
                Label("Choose device permissions", systemImage: "hand.raised")
                    .font(OpenClawType.subheadSemiBold)
                Label("Use OpenClaw from your phone", systemImage: "message.fill")
                    .font(OpenClawType.subheadSemiBold)
            }
            .font(OpenClawType.subheadSemiBold)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background {
                RoundedRectangle(cornerRadius: OpenClawRadius.xl, style: .continuous)
                    .fill(OpenClawBrand.slate)
            }
            .padding(.horizontal, OpenClawSpacing.space6)
            .padding(.bottom, 16)

            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(OpenClawType.title3)
                    .foregroundStyle(OpenClawBrand.warn)
                    .frame(width: 24)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Security notice")
                        .font(OpenClawType.headline)
                        .foregroundStyle(OpenClawBrand.textPrimary)
                    Text(
                        "The connected OpenClaw agent can use device capabilities you enable, "
                            + "such as camera, microphone, photos, contacts, calendar, and location. "
                            + "Continue only if you trust the gateway and agent you connect to.")
                        .font(OpenClawType.footnote)
                        .foregroundStyle(OpenClawBrand.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background {
                RoundedRectangle(cornerRadius: OpenClawRadius.xl, style: .continuous)
                    .fill(OpenClawBrand.slate)
            }
            .padding(.horizontal, OpenClawSpacing.space6)

            Spacer()

            Button {
                self.onContinue()
            } label: {
                Text("Continue")
                    .font(OpenClawType.headline)
            }
            .font(OpenClawType.headline)
            .openClawPrimaryButton()
            .padding(.horizontal, OpenClawSpacing.space6)
            .padding(.bottom, 48)
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
                .foregroundStyle(.tint)
                .padding(.bottom, 20)

            Text("Connect Gateway")
                .font(OpenClawType.title1)
                .foregroundStyle(OpenClawBrand.textPrimary)
                .padding(.bottom, 8)

            Text("Scan a QR code from your OpenClaw gateway or continue with manual setup.")
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, OpenClawSpacing.space8)

            VStack(alignment: .leading, spacing: 8) {
                Text("How to pair")
                    .font(OpenClawType.headline)
                Text("In your OpenClaw chat, run")
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
                Text("/pair qr")
                    .font(OpenClawType.monoFootnote)
                Text("Then scan the QR code here to connect this device.")
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(OpenClawSpacing.space4)
            .background {
                RoundedRectangle(cornerRadius: OpenClawRadius.xl, style: .continuous)
                    .fill(OpenClawBrand.slate)
            }
            .padding(.horizontal, OpenClawSpacing.space6)
            .padding(.top, 20)

            Spacer()

            VStack(spacing: 12) {
                Button {
                    self.onScanQRCode()
                } label: {
                    Label("Scan QR Code", systemImage: "qrcode")
                        .font(OpenClawType.headline)
                }
                .font(OpenClawType.headline)
                .openClawPrimaryButton()

                Button {
                    self.onManualSetup()
                } label: {
                    Text("Set Up Manually")
                        .font(OpenClawType.headline)
                }
                .font(OpenClawType.headline)
                .openClawSecondaryButton()
            }
            .padding(.horizontal, OpenClawSpacing.space6)
            .padding(.bottom, 12)

            Text(self.statusLine)
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, OpenClawSpacing.space6)
                .padding(.bottom, 48)
        }
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
