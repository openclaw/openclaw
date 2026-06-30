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

struct OnboardingConnectionPathStep: View {
    @Environment(\.colorScheme) private var colorScheme
    @Binding var setupCode: String
    let statusLine: String
    let discoveryStatusText: String
    let gatewayStatusText: String
    let setupCodeStatus: String?
    let bestGateway: GatewayDiscoveryModel.DiscoveredGateway?
    let connectingGatewayID: String?
    let onScanQRCode: () -> Void
    let onApplySetupCode: () -> Void
    let onConnectDiscoveredGateway: (GatewayDiscoveryModel.DiscoveredGateway) -> Void
    let onChooseLocalNetwork: () -> Void
    let onChooseTailscaleOrRemote: () -> Void
    let onChooseManualSetup: () -> Void

    private var isBusy: Bool {
        self.connectingGatewayID != nil
    }

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    self.header
                    self.discoveryCard
                    self.quickPairCard
                    self.otherWaysCard
                    self.statusFooter
                }
                .padding(.top, 18)
                .padding(.bottom, 32)
                .padding(.horizontal, OpenClawProMetric.pagePadding)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                OpenClawProMark(size: 38, shadowRadius: 8)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Connect Gateway")
                        .font(.title.weight(.bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                    Text("Make this iPhone a secure OpenClaw node.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 8) {
                ProCapsule(
                    title: self.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? "Gateway not connected"
                        : self.gatewayStatusText,
                    color: self.gatewayStatusColor,
                    icon: self.gatewayStatusIcon)
                ProCapsule(
                    title: self.discoveryStatusText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? "Discovery idle"
                        : self.discoveryStatusText,
                    color: .secondary,
                    icon: "dot.radiowaves.left.and.right")
            }
        }
    }

    @ViewBuilder
    private var discoveryCard: some View {
        if let bestGateway {
            ProCard(tint: OpenClawBrand.ok, isProminent: true, padding: 14, radius: 18) {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .top, spacing: 12) {
                        ProIconBadge(systemName: "antenna.radiowaves.left.and.right", color: OpenClawBrand.ok)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Nearby gateway found")
                                .font(.headline.weight(.semibold))
                            Text(bestGateway.name)
                                .font(.subheadline.weight(.medium))
                            Text(self.gatewayEndpointLabel(bestGateway))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer(minLength: 8)
                        ProCapsule(title: "Best path", color: OpenClawBrand.ok, icon: "sparkle")
                    }

                    Button {
                        self.onConnectDiscoveredGateway(bestGateway)
                    } label: {
                        HStack(spacing: 8) {
                            if self.connectingGatewayID == bestGateway.id {
                                ProgressView()
                                    .progressViewStyle(.circular)
                                    .tint(.white)
                            } else {
                                Image(systemName: "link")
                            }
                            Text(self.connectingGatewayID == bestGateway.id ? "Connecting..." : "Connect to gateway")
                        }
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(OpenClawBrand.ok, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(self.isBusy)
                }
            }
        } else {
            ProCard(tint: OpenClawBrand.accent, isProminent: true, padding: 14, radius: 18) {
                HStack(alignment: .top, spacing: 12) {
                    ProIconBadge(systemName: "dot.radiowaves.left.and.right", color: OpenClawBrand.accent)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Looking for your gateway")
                            .font(.headline.weight(.semibold))
                        Text("If the gateway is on this network, it will appear here automatically.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    ProgressView()
                        .controlSize(.small)
                }
            }
        }
    }

    private var quickPairCard: some View {
        ProCard(padding: 14, radius: 18) {
            VStack(alignment: .leading, spacing: 14) {
                ProPanelHeader(title: "Pair another way", value: "QR or setup code")
                    .padding(.horizontal, -14)
                    .padding(.top, -12)
                    .padding(.bottom, -8)

                Button {
                    self.onScanQRCode()
                } label: {
                    Label("Scan setup QR", systemImage: "qrcode.viewfinder")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(OpenClawBrand.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(self.isBusy)

                VStack(alignment: .leading, spacing: 9) {
                    Text("Setup code")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    HStack(spacing: 10) {
                        TextField("Paste setup code or secure gateway URL", text: self.$setupCode)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 12)
                            .frame(height: 44)
                            .background(self.inputFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
                            }
                            .onSubmit(self.onApplySetupCode)

                        Button {
                            self.onApplySetupCode()
                        } label: {
                            if self.connectingGatewayID == "setup-code" {
                                ProgressView()
                                    .progressViewStyle(.circular)
                            } else {
                                Image(systemName: "arrow.right")
                                    .font(.headline.weight(.semibold))
                            }
                        }
                        .frame(width: 44, height: 44)
                        .foregroundStyle(.white)
                        .background(self.canApplySetupCode ? OpenClawBrand.accent : Color.secondary, in: Circle())
                        .disabled(!self.canApplySetupCode || self.isBusy)
                    }

                    if let setupCodeStatus, !setupCodeStatus.isEmpty {
                        Text(setupCodeStatus)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private var otherWaysCard: some View {
        ProCard(padding: 0, radius: 18) {
            VStack(spacing: 0) {
                ProPanelHeader(title: "Other connection paths", value: "Advanced")
                Divider()
                self.pathRow(
                    icon: "house.and.flag",
                    title: "Local network",
                    detail: "Use Bonjour discovery or a local gateway host.",
                    color: OpenClawBrand.info,
                    action: self.onChooseLocalNetwork)
                Divider().padding(.leading, 56)
                self.pathRow(
                    icon: "lock.icloud",
                    title: "Tailscale",
                    detail: "Enter a Tailscale URL, MagicDNS name, or 100.x IP.",
                    color: OpenClawBrand.accent,
                    action: self.onChooseTailscaleOrRemote)
                Divider().padding(.leading, 56)
                self.pathRow(
                    icon: "slider.horizontal.3",
                    title: "Manual host",
                    detail: "Enter host, port, TLS, and credentials yourself.",
                    color: .secondary,
                    action: self.onChooseManualSetup)
            }
        }
    }

    private var statusFooter: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.shield")
                .foregroundStyle(.secondary)
                .frame(width: 20)
            Text(self.footerText)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 4)
    }

    private func pathRow(
        icon: String,
        title: String,
        detail: String,
        color: Color,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: icon, color: color)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(self.isBusy)
    }

    private func gatewayEndpointLabel(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String {
        if let host = gateway.lanHost?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty {
            return host
        }
        if let host = gateway.tailnetDns?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty {
            return host
        }
        return gateway.debugID
    }

    private var canApplySetupCode: Bool {
        !self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var inputFill: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.06) : Color.black.opacity(0.035)
    }

    private var gatewayStatusColor: Color {
        switch self.gatewayStatusKind {
        case .connected:
            OpenClawBrand.ok
        case .problem:
            OpenClawBrand.warn
        case .disconnected:
            .secondary
        }
    }

    private var gatewayStatusIcon: String {
        switch self.gatewayStatusKind {
        case .connected:
            "checkmark.circle.fill"
        case .problem:
            "exclamationmark.triangle.fill"
        case .disconnected:
            "wifi.slash"
        }
    }

    private var gatewayStatusKind: GatewayStatusKind {
        let text = self.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = text.lowercased()
        if text == "Connected" { return .connected }
        if lower.contains("error") || lower.contains("reject") || lower.contains("failed") {
            return .problem
        }
        return .disconnected
    }

    private var footerText: String {
        let trimmed = self.statusLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return "QR and setup-code pairing keep gateway auth out of manual setup."
        }
        return trimmed
    }

    private enum GatewayStatusKind {
        case connected
        case problem
        case disconnected
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
