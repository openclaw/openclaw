import SwiftUI

struct VoiceWakeToast: View {
    @Environment(\.colorSchemeContrast) private var contrast

    var command: String
    var brighten: Bool = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "mic.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)

            Text(self.command)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(
                            .white.opacity(self.contrast == .increased ? 0.5 : (self.brighten ? 0.24 : 0.18)),
                            lineWidth: self.contrast == .increased ? 1.0 : 0.5
                        )
                }
                .shadow(color: .black.opacity(0.25), radius: 12, y: 6)
        }
        .accessibilityLabel("Voice Wake triggered")
        .accessibilityValue("Command: \(self.command)")
    }
}
