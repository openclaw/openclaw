import SwiftUI

struct TalkOrbOverlay: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var pulse: Bool = false

    var body: some View {
        let seam = self.appModel.seamColor
        let status = self.appModel.talkMode.statusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let mic = min(max(self.appModel.talkMode.micLevel, 0), 1)

        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .stroke(seam.opacity(0.26), lineWidth: 2)
                    .frame(width: 320, height: 320)
                    .scaleEffect(self.pulse ? 1.15 : 0.96)
                    .opacity(self.pulse ? 0.0 : 1.0)
                    .animation(.easeOut(duration: 1.3).repeatForever(autoreverses: false), value: self.pulse)

                Circle()
                    .stroke(seam.opacity(0.18), lineWidth: 2)
                    .frame(width: 320, height: 320)
                    .scaleEffect(self.pulse ? 1.45 : 1.02)
                    .opacity(self.pulse ? 0.0 : 0.9)
                    .animation(.easeOut(duration: 1.9).repeatForever(autoreverses: false).delay(0.2), value: self.pulse)

                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                seam.opacity(0.75 + (0.20 * mic)),
                                seam.opacity(0.40),
                                Color.black.opacity(0.55),
                            ],
                            center: .center,
                            startRadius: 1,
                            endRadius: 112))
                    .frame(width: 190, height: 190)
                    .scaleEffect(1.0 + (0.12 * mic))
                    .overlay(
                        Circle()
                            .stroke(seam.opacity(0.35), lineWidth: 1))
                    .shadow(color: seam.opacity(0.32), radius: 26, x: 0, y: 0)
                    .shadow(color: Color.black.opacity(0.50), radius: 22, x: 0, y: 10)
            }
            .contentShape(Circle())
            .onTapGesture {
                self.appModel.talkMode.userTappedOrb()
            }

            let agentName = self.appModel.activeAgentName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !agentName.isEmpty {
                Text("Bot: \(agentName)")
                    .font(.system(.caption, design: .rounded).weight(.semibold))
                    .foregroundStyle(Color.white.opacity(0.70))
            }

            if !status.isEmpty, status != "Off" {
                Text(status)
                    .font(.system(.footnote, design: .rounded).weight(.semibold))
                    .foregroundStyle(Color.white.opacity(0.92))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        Capsule()
                            .fill(Color.black.opacity(0.40))
                            .overlay(
                                Capsule().stroke(seam.opacity(0.22), lineWidth: 1)))
            }

            if self.appModel.talkMode.isListening {
                Capsule()
                    .fill(seam.opacity(0.90))
                    .frame(width: max(18, 180 * mic), height: 6)
                    .animation(.easeOut(duration: 0.12), value: mic)
                    .accessibilityLabel("Microphone level")
            }
        }
        .padding(28)
        .onAppear {
            self.pulse = true
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Talk Mode \(status)")
    }
}
