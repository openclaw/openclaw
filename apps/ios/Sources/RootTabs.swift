import SwiftUI

struct RootTabs: View {
    @EnvironmentObject private var appModel: NodeAppModel
    @State private var isConnectingPulse: Bool = false

    var body: some View {
        TabView {
            ScreenTab()
                .tabItem { Label("Screen", systemImage: "rectangle.and.hand.point.up.left") }

            VoiceTab()
                .tabItem { Label("Voice", systemImage: "mic") }

            SettingsTab()
                .tabItem {
                    VStack {
                        ZStack(alignment: .topTrailing) {
                            Image(systemName: "gearshape")
                            Circle()
                                .fill(self.settingsIndicatorColor)
                                .frame(width: 9, height: 9)
                                .overlay(
                                    Circle()
                                        .stroke(.black.opacity(0.2), lineWidth: 0.5))
                                .shadow(
                                    color: self.settingsIndicatorGlowColor,
                                    radius: self.settingsIndicatorGlowRadius,
                                    x: 0,
                                    y: 0)
                                .scaleEffect(self.settingsIndicatorScale)
                                .opacity(self.settingsIndicatorOpacity)
                                .offset(x: 7, y: -2)
                        }
                        Text("Settings")
                    }
                }
        }
        .onAppear { self.updateConnectingPulse(for: self.bridgeIndicatorState) }
        .onChange(of: self.bridgeIndicatorState) { _, newValue in
            self.updateConnectingPulse(for: newValue)
        }
    }

    private enum BridgeIndicatorState {
        case connected
        case connecting
        case disconnected
    }

    private var bridgeIndicatorState: BridgeIndicatorState {
        if self.appModel.bridgeServerName != nil { return .connected }
        if self.appModel.bridgeStatusText.localizedCaseInsensitiveContains("connecting") { return .connecting }
        return .disconnected
    }

    private var settingsIndicatorColor: Color {
        switch self.bridgeIndicatorState {
        case .connected:
            Color.green
        case .connecting:
            Color.yellow
        case .disconnected:
            Color.red
        }
    }

    private var settingsIndicatorGlowColor: Color {
        switch self.bridgeIndicatorState {
        case .connected:
            Color.green.opacity(0.75)
        case .connecting:
            Color.yellow.opacity(0.6)
        case .disconnected:
            Color.clear
        }
    }

    private var settingsIndicatorGlowRadius: CGFloat {
        switch self.bridgeIndicatorState {
        case .connected:
            6
        case .connecting:
            self.isConnectingPulse ? 6 : 3
        case .disconnected:
            0
        }
    }

    private var settingsIndicatorScale: CGFloat {
        guard self.bridgeIndicatorState == .connecting else { return 1 }
        return self.isConnectingPulse ? 1.12 : 0.96
    }

    private var settingsIndicatorOpacity: Double {
        guard self.bridgeIndicatorState == .connecting else { return 1 }
        return self.isConnectingPulse ? 1.0 : 0.75
    }

    private func updateConnectingPulse(for state: BridgeIndicatorState) {
        guard state == .connecting else {
            withAnimation(.easeOut(duration: 0.2)) { self.isConnectingPulse = false }
            return
        }

        guard !self.isConnectingPulse else { return }
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
            self.isConnectingPulse = true
        }
    }
}
