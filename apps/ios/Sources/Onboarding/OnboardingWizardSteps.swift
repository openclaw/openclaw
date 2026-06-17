import SwiftUI

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

            Text("Turn this device into a secure OpenClaw node for chat, voice, camera, and device tools.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .padding(.bottom, 24)

            VStack(alignment: .leading, spacing: 14) {
                Label("Connect to your gateway", systemImage: "link")
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
    let statusLine: String
    let discoveredGateways: [GatewayDiscoveryModel.DiscoveredGateway]
    let nearbyDiscoveryEnabled: Bool
    let isRefreshingNearbyGateways: Bool
    let discoveryStatusText: String
    let onSetNearbyDiscoveryEnabled: (Bool) -> Void
    let onScanQRCode: () -> Void
    let onSelectGateway: (GatewayDiscoveryModel.DiscoveredGateway) -> Void
    let onManualSetup: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Image(systemName: "qrcode.viewfinder")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
                .padding(.bottom, 20)

            Text("Connect Gateway")
                .font(.largeTitle.weight(.bold))
                .padding(.bottom, 8)

            Text("Scan a QR code from your OpenClaw gateway or continue with manual setup.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            OnboardingPairingInstructionsSection()
                .padding(.horizontal, 24)
                .padding(.top, 20)

            NearbyGatewaySetupSection(
                isEnabled: self.nearbyDiscoveryEnabled,
                discoveredGateways: self.discoveredGateways,
                isRefreshing: self.isRefreshingNearbyGateways,
                discoveryStatusText: self.discoveryStatusText,
                onSetEnabled: self.onSetNearbyDiscoveryEnabled,
                onSelectGateway: self.onSelectGateway)
                .padding(.horizontal, 24)
                .padding(.top, 12)

            Spacer()

            VStack(spacing: 12) {
                Button {
                    self.onScanQRCode()
                } label: {
                    Label("Scan QR Code", systemImage: "qrcode")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button {
                    self.onManualSetup()
                } label: {
                    Text("Set Up Manually")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)

            Text(self.statusLine)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
                .padding(.bottom, 48)
        }
    }
}

private struct OnboardingPairingInstructionsSection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("How to pair")
                .font(.headline)
            Text("In your OpenClaw chat, run")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text("/pair qr")
                .font(.system(.footnote, design: .monospaced).weight(.semibold))
            Text("Then scan the QR code here to connect this device.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(uiColor: .secondarySystemBackground))
        }
    }
}

private struct NearbyGatewaySetupSection: View {
    let isEnabled: Bool
    let discoveredGateways: [GatewayDiscoveryModel.DiscoveredGateway]
    let isRefreshing: Bool
    let discoveryStatusText: String
    let onSetEnabled: (Bool) -> Void
    let onSelectGateway: (GatewayDiscoveryModel.DiscoveredGateway) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("NEARBY DISCOVERY")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
                if self.isRefreshing {
                    ProgressView()
                        .progressViewStyle(.circular)
                }
            }
            .padding(.horizontal, 16)

            VStack(alignment: .leading, spacing: 0) {
                NearbyGatewayDiscoveryToggleRow(
                    isEnabled: self.isEnabled,
                    onSetEnabled: self.onSetEnabled)

                if self.isEnabled {
                    Divider()
                        .padding(.leading, 16)

                    if self.discoveredGateways.isEmpty {
                        Text(self.discoveryStatusText)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                    } else {
                        ForEach(self.discoveredGateways) { gateway in
                            NearbyGatewaySetupRow(
                                name: gateway.name,
                                host: gateway.lanHost ?? gateway.tailnetDns ?? "Local network")
                            {
                                self.onSelectGateway(gateway)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemBackground))
            }
        }
    }
}

private struct NearbyGatewayDiscoveryToggleRow: View {
    let isEnabled: Bool
    let onSetEnabled: (Bool) -> Void

    var body: some View {
        Toggle(
            "Enabled",
            isOn: Binding(
                get: { self.isEnabled },
                set: self.onSetEnabled))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
    }
}

private struct NearbyGatewaySetupRow: View {
    let name: String
    let host: String
    let onSelect: () -> Void

    var body: some View {
        Button(action: self.onSelect) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: self.name)
                        .font(.subheadline.weight(.semibold))
                    Text(verbatim: self.host)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
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
