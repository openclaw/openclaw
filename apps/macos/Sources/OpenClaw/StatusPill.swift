import SwiftUI

struct StatusPill: View {
    let text: String
    let tint: Color

    var body: some View {
        let baseTint = self.tint == .secondary
            ? Color(red: 0.64, green: 0.71, blue: 0.79)
            : self.tint

        Text(self.text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .foregroundStyle(self.tint == .secondary ? .secondary : baseTint)
            .background(
                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.58),
                                baseTint.opacity(0.10),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(Color.white.opacity(0.24), lineWidth: 0.7)
            )
            .shadow(color: baseTint.opacity(0.06), radius: 8, y: 4)
    }
}
