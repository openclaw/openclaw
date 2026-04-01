import AppKit
import Observation
import OpenClawKit
import SwiftUI

struct ColorSettings: View {
    @Bindable var store: ColorPreferencesStore
    @State private var customColor: Color = .blue
    @Environment(\.colorScheme) private var colorScheme

    init(store: ColorPreferencesStore = .shared) {
        self.store = store
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Theme Color")
                        .font(.title3.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Text("Choose a color to personalize the OpenClaw interface.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Divider()

                    SettingsToggleRow(
                        title: "Use Accent Color",
                        subtitle: "Use the system accent color from macOS settings.",
                        binding: self.accentColorBinding)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Palette Colors")
                            .font(.callout.weight(.semibold))

                        LazyVGrid(
                            columns: [
                                GridItem(.adaptive(minimum: 60, maximum: 80), spacing: 12)
                            ],
                            spacing: 12
                        ) {
                            ForEach(Array(ColorPalette.colors.enumerated()), id: \.offset) { index, paletteColor in
                                self.paletteColorButton(index: index, paletteColor: paletteColor)
                            }
                        }
                        .padding(.vertical, 8)
                    }

                    Divider()

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Custom Color")
                            .font(.callout.weight(.semibold))

                        HStack(spacing: 12) {
                            ColorPicker("", selection: self.$customColor, supportsOpacity: false)
                                .labelsHidden()
                                .frame(width: 60, height: 40)

                            Button {
                                self.applyCustomColor()
                            } label: {
                                Text("Apply Custom Color")
                            }
                            .buttonStyle(.borderedProminent)

                            if self.store.customColorHex != nil {
                                Button {
                                    self.clearCustomColor()
                                } label: {
                                    Text("Clear")
                                }
                                .buttonStyle(.bordered)
                            }
                        }

                        if let hex = self.store.customColorHex {
                            Text("Current: \(hex)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Spacer(minLength: 12)

                VStack(alignment: .leading, spacing: 10) {
                    Text("Preview")
                        .font(.callout.weight(.semibold))

                    HStack(spacing: 12) {
                        Circle()
                            .fill(self.store.resolvedColor)
                            .frame(width: 40, height: 40)

                        VStack(alignment: .leading, spacing: 2) {
                            Text("Current Theme Color")
                                .font(.caption.weight(.semibold))
                            Text(self.currentColorDescription)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(12)
                    .background(Color.gray.opacity(0.08))
                    .cornerRadius(10)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 22)
            .padding(.bottom, 16)
        }
        .onAppear {
            if let hex = self.store.customColorHex,
               let color = OpenClawKit.ColorHexSupport.color(fromHex: hex)
            {
                self.customColor = color
            }
        }
    }

    // MARK: - Computed Properties

    private var accentColorBinding: Binding<Bool> {
        Binding(
            get: { self.store.useAccentColor },
            set: { newValue in
                self.store.useAccentColor = newValue
            })
    }

    private var currentColorDescription: String {
        if self.store.useAccentColor {
            return "System Accent Color"
        } else if let hex = self.store.customColorHex {
            return "Custom (\(hex))"
        } else if let index = self.store.selectedPaletteIndex {
            return "Palette Color \(index + 1)"
        }
        return "System Accent Color"
    }

    // MARK: - View Builders

    @ViewBuilder
    private func paletteColorButton(index: Int, paletteColor: ColorPalette.PaletteColor) -> some View {
        let isSelected = self.store.selectedPaletteIndex == index
        let displayColor = self.colorScheme == .dark ? paletteColor.dark : paletteColor.light

        Button {
            self.selectPaletteColor(index: index)
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(displayColor)
                    .frame(width: 60, height: 40)

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(OpenClawKit.ColorHexSupport.contrastingTextColor(for: displayColor))
                        .font(.title3)
                        .shadow(radius: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isSelected ? Color.primary.opacity(0.3) : Color.clear, lineWidth: 2)
        )
    }

    // MARK: - Actions

    private func selectPaletteColor(index: Int) {
        self.store.customColorHex = nil
        self.store.selectedPaletteIndex = index
        self.store.useAccentColor = false
    }

    private func applyCustomColor() {
        if let hex = OpenClawKit.ColorHexSupport.hex(from: self.customColor) {
            self.store.selectedPaletteIndex = nil
            self.store.customColorHex = hex
            self.store.useAccentColor = false
        }
    }

    private func clearCustomColor() {
        self.store.customColorHex = nil
        if self.store.selectedPaletteIndex == nil {
            self.store.useAccentColor = true
        }
    }
}

#if DEBUG
struct ColorSettings_Previews: PreviewProvider {
    static var previews: some View {
        ColorSettings(store: .shared)
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
