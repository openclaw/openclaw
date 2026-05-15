import SwiftUI

struct AmbientOverlayView: View {
    let intensity: Double

    var body: some View {
        ZStack {
            Color.clear

            Rectangle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color.white.opacity(0),
                            Color.white.opacity(self.edgeOpacity * 0.12),
                            Color.cyan.opacity(self.edgeOpacity * 0.18),
                        ],
                        center: .center,
                        startRadius: 260,
                        endRadius: 900))
                .blendMode(.screen)

            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(self.edgeOpacity * 0.36),
                            Color.cyan.opacity(self.edgeOpacity * 0.28),
                            Color.white.opacity(self.edgeOpacity * 0.18),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing),
                    lineWidth: 2)
                .shadow(color: Color.cyan.opacity(self.edgeOpacity * 0.32), radius: 24)
                .padding(10)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    private var edgeOpacity: Double {
        min(max(self.intensity, 0), 1)
    }
}

struct AmbientWorkspaceSheetView: View {
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Ambient Workspace")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.primary)

                Text("Ready")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 16)

            Button(action: self.onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Close")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(width: 420, height: 86)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
        .shadow(color: Color.black.opacity(0.18), radius: 18, x: 0, y: 8)
    }
}
