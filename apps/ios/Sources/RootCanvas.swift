import SwiftUI

struct RootCanvas: View {
    @State private var isShowingSettings = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ScreenTab()

            Button {
                self.isShowingSettings = true
            } label: {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.primary)
                    .padding(10)
                    .background {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(.ultraThinMaterial)
                            .overlay {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(
                                        LinearGradient(
                                            colors: [
                                                .white.opacity(0.18),
                                                .white.opacity(0.04),
                                                .clear,
                                            ],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing))
                                    .blendMode(.overlay)
                            }
                            .overlay {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(.white.opacity(0.18), lineWidth: 0.5)
                            }
                            .shadow(color: .black.opacity(0.35), radius: 12, y: 6)
                    }
            }
            .buttonStyle(.plain)
            .padding(.top, 10)
            .padding(.trailing, 10)
            .accessibilityLabel("Settings")
        }
        .sheet(isPresented: self.$isShowingSettings) {
            SettingsTab()
        }
    }
}
