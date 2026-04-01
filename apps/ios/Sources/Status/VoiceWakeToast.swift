import SwiftUI

struct VoiceWakeToast: View {
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
        .statusGlassCard(brighten: self.brighten, verticalPadding: 10)
        .accessibilityLabel("Voice Wake triggered")
        .accessibilityValue("Command: \(self.command)")
    }
}
