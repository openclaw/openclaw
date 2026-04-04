import Observation
import OpenClawChatUI
import SwiftUI

enum WebChatWorkspaceMode: String, CaseIterable, Identifiable {
    case control
    case chat
    case correction

    var id: Self { self }

    var title: String {
        switch self {
        case .control:
            "Control"
        case .chat:
            "Chat"
        case .correction:
            "Cases"
        }
    }

    var systemImage: String {
        switch self {
        case .control:
            "switch.2"
        case .chat:
            "bubble.left.and.bubble.right.fill"
        case .correction:
            "cross.case.fill"
        }
    }

    var windowTitle: String {
        switch self {
        case .control:
            Branding.controlWindowTitle
        case .chat:
            Branding.chatWindowTitle
        case .correction:
            Branding.canvasWindowTitle
        }
    }

    var subtitle: String {
        switch self {
        case .control:
            "Check system status first."
        case .chat:
            "Steer the active bot."
        case .correction:
            "Review evidence before dispatch."
        }
    }
}

@MainActor
@Observable
final class WebChatWorkspaceRouter {
    var selectedMode: WebChatWorkspaceMode

    init(selectedMode: WebChatWorkspaceMode = .control) {
        self.selectedMode = selectedMode
    }
}

struct WebChatWorkspaceRootView: View {
    @Bindable var router: WebChatWorkspaceRouter
    @Bindable var state: AppState
    let chatViewModel: OpenClawChatViewModel
    let userAccent: Color?
    private let activityStore = WorkActivityStore.shared

    var body: some View {
        GeometryReader { proxy in
            let usesCompactTopBar = proxy.size.width < 980

            VStack(spacing: 0) {
                self.topBar(usesCompactLayout: usesCompactTopBar)

                Group {
                    switch self.router.selectedMode {
                    case .control:
                        ControlDashboardView(router: self.router, state: self.state)
                    case .chat:
                        OpenClawChatView(
                            viewModel: self.chatViewModel,
                            showsSessionSwitcher: true,
                            style: .workspace,
                            userAccent: self.userAccent)
                    case .correction:
                        CorrectionWorkspaceView(state: self.state)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private func topBar(usesCompactLayout: Bool) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(.clear)
                .background(
                    VisualEffectView(
                        material: .hudWindow,
                        blendingMode: .withinWindow,
                        emphasized: false)
                )
                .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))

            Ellipse()
                .fill(Color(red: 0.98, green: 0.82, blue: 0.60).opacity(0.20))
                .frame(width: 236, height: 134)
                .blur(radius: 60)
                .offset(x: -228, y: -18)

            Ellipse()
                .fill(Color(red: 0.74, green: 0.87, blue: 0.97).opacity(0.18))
                .frame(width: 286, height: 168)
                .blur(radius: 64)
                .offset(x: 236, y: 14)

            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.48),
                            Color.white.opacity(0.10),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing),
                    lineWidth: 0.8)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) {
                    self.topBarBrand
                        .frame(maxWidth: .infinity, alignment: .leading)

                    self.workspacePicker
                        .frame(width: 288)

                    self.topBarBadgeRow
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }

                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 12) {
                        self.topBarBrand
                        Spacer(minLength: 0)
                        self.topBarBadgeRow
                    }

                    self.workspacePicker
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .frame(height: usesCompactLayout ? 100 : 78)
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .shadow(color: Color(red: 0.43, green: 0.56, blue: 0.70).opacity(0.08), radius: 20, y: 8)
    }

    private var topBarBrand: some View {
        HStack(spacing: 10) {
            VeriClawBrandTile(size: 34)

            VStack(alignment: .leading, spacing: 1) {
                Text("VeriClaw")
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                Text(self.router.selectedMode.title)
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(0.8)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private var workspacePicker: some View {
        Picker("Workspace", selection: self.$router.selectedMode) {
            ForEach(WebChatWorkspaceMode.allCases) { mode in
                Label(mode.title, systemImage: mode.systemImage)
                    .tag(mode)
                    .help(mode.windowTitle)
            }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .controlSize(.regular)
        .tint(Color(red: 0.56, green: 0.76, blue: 0.38))
        .accessibilityLabel("Workspace")
        .accessibilityValue(self.router.selectedMode.title)
    }

    private var topBarBadgeRow: some View {
        HStack(spacing: 6) {
            self.workspaceBadge(
                systemImage: "circle.fill",
                value: self.condensedMainSessionLabel,
                tint: Color(red: 0.93, green: 0.78, blue: 0.58))
            if let current = self.activityStore.current {
                self.workspaceBadge(
                    systemImage: current.role == .main ? "waveform" : "arrow.triangle.branch",
                    value: self.condensedActivityLabel(for: current.label),
                    tint: Color(red: 0.74, green: 0.87, blue: 0.97))
            } else {
                self.workspaceBadge(
                    systemImage: "moon.stars.fill",
                    value: "Idle",
                    tint: Color(red: 0.84, green: 0.88, blue: 0.94))
            }
        }
    }

    private var condensedMainSessionLabel: String {
        self.condensedActivityLabel(for: self.activityStore.mainSessionKey)
    }

    private func condensedActivityLabel(for value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "Idle" }
        if trimmed.count <= 18 { return trimmed }
        return "\(trimmed.prefix(15))…"
    }

    private func workspaceBadge(systemImage: String, value: String, tint: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(tint)

            Text(value)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(
            Capsule(style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.38),
                            tint.opacity(0.06),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(Color.white.opacity(0.22), lineWidth: 0.8)))
    }
}
