import SwiftUI

struct ReferenceTalkSurface: View {
    let isEnabled: Bool
    let isListening: Bool
    let isSpeaking: Bool
    let statusText: String
    let inputLevel: Double
    let outputLevel: Double?
    let toggle: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 30)
            Text(self.statusText)
                .font(OpenClawType.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 18)

            Spacer(minLength: 24)

            ReferenceVoiceWaveform(
                isActive: self.isEnabled || self.isListening || self.isSpeaking,
                level: self.isSpeaking ? (self.outputLevel ?? 0.35) : self.inputLevel)
                .frame(height: 86)
                .accessibilityHidden(true)

            Spacer()

            Image(systemName: self.isEnabled ? "lock.open" : "lock")
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(.secondary)
                .padding(.bottom, 13)

            HStack {
                Button(action: self.toggle) {
                    Image(systemName: self.isEnabled ? "stop.fill" : "mic.fill")
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 58, height: 48)
                        .background(OpenClawBrand.accent, in: Capsule())
                        .overlay { Capsule().stroke(Color.white.opacity(0.4), lineWidth: 1) }
                        .shadow(color: OpenClawBrand.accent.opacity(0.28), radius: 6, y: 2)
                }
                .accessibilityLabel(self.isEnabled ? "Stop talking" : "Start talking")
                .accessibilityIdentifier("assistant-talk-control")
            }

            Text(self.isEnabled ? "Tap to stop Talk" : "Tap to start Talk")
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 80)
                .padding(.top, 8)
                .padding(.bottom, 12)
        }
        .background(Color(uiColor: .systemBackground))
        .accessibilityIdentifier("reference-talk-screen")
    }
}

private struct ReferenceVoiceWaveform: View {
    let isActive: Bool
    let level: Double
    private let bars: [CGFloat] = [
        2, 3, 4, 6, 9, 13, 17, 22, 28, 32, 35, 36, 34, 29, 21, 11, 4, 10, 21, 43, 55, 44, 22, 10,
        6, 9, 13, 17, 20, 23, 25, 27, 30, 32, 34, 36, 39, 43, 47, 51,
    ]

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width / CGFloat(self.bars.count)
            HStack(alignment: .center, spacing: 1) {
                ForEach(Array(self.bars.enumerated()), id: \.offset) { index, height in
                    Capsule()
                        .fill(Color.secondary.opacity(self.isActive ? 0.9 : 0.62))
                        .frame(
                            width: max(1, width - 1),
                            height: max(
                                2,
                                height * (self.isActive
                                    ? CGFloat(0.45 + min(max(self.level, 0), 1))
                                    : 0.3)))
                        .animation(
                            .easeInOut(duration: 0.45).repeatForever(autoreverses: true)
                                .delay(Double(index % 7) * 0.04),
                            value: self.isActive)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay {
                Rectangle()
                    .fill(Color.secondary.opacity(0.45))
                    .frame(height: 1)
            }
        }
    }
}
