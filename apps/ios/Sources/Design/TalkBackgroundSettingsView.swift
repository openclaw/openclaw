import PhotosUI
import SwiftUI

struct TalkBackgroundSettingsView: View {
    @AppStorage(TalkDefaults.wallpaperSelectionKey) private var wallpaperSelectionRaw =
        TalkWallpaperSelection.default.rawValue
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var customPreview: UIImage?

    private var selection: TalkWallpaperSelection {
        TalkWallpaperSelection(rawValue: self.wallpaperSelectionRaw) ?? .default
    }

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    ProSectionHeader(title: "Wallpapers", uppercase: false)

                    ProCard(radius: SettingsLayout.cardRadius) {
                        VStack(alignment: .leading, spacing: 20) {
                            Text("Choose a wallpaper for the Talk screen. Default gray matches the app background.")
                                .font(OpenClawProFont.minimum)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)

                            LazyVGrid(
                                columns: [
                                    GridItem(.flexible(), spacing: 12),
                                    GridItem(.flexible(), spacing: 12),
                                    GridItem(.flexible(), spacing: 12),
                                ],
                                spacing: 12)
                            {
                                self.wallpaperOption(
                                    title: TalkWallpaperSelection.default.label,
                                    isSelected: self.selection == .default,
                                    preview: AnyView(self.defaultPreview))
                                {
                                    self.select(.default)
                                }

                                self.wallpaperOption(
                                    title: TalkWallpaperSelection.ocean.label,
                                    isSelected: self.selection == .ocean,
                                    preview: AnyView(self.oceanPreview))
                                {
                                    self.select(.ocean)
                                }

                                self.wallpaperOption(
                                    title: TalkWallpaperSelection.custom.label,
                                    isSelected: self.selection == .custom,
                                    preview: AnyView(self.customPreviewView))
                                {
                                    if TalkWallpaperStore.hasCustomImage() {
                                        self.select(.custom)
                                    } else {
                                        // Selecting the tile opens the album picker when empty.
                                    }
                                }
                            }

                            HStack(spacing: 12) {
                                PhotosPicker(selection: self.$selectedPhoto, matching: .images) {
                                    Label("Choose from album", systemImage: "photo.on.rectangle")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)

                                Button("Reset to default") {
                                    self.resetToDefault()
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                    }
                    .padding(.horizontal, OpenClawProMetric.pagePadding)
                }
                .padding(.top, 18)
                .padding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
        }
        .navigationTitle("Call Background")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .onAppear {
            self.customPreview = TalkWallpaperStore.customImage()
        }
        .onChange(of: self.selectedPhoto) { _, item in
            guard let item else { return }
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self),
                      let image = UIImage(data: data),
                      let jpeg = image.jpegData(compressionQuality: 0.88)
                else {
                    return
                }
                try? TalkWallpaperStore.saveCustomImage(jpeg)
                await MainActor.run {
                    self.customPreview = image
                    self.select(.custom)
                    self.selectedPhoto = nil
                }
            }
        }
    }

    private var defaultPreview: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(TalkDefaults.defaultWallpaperColor)
    }

    private var oceanPreview: some View {
        Group {
            if let image = TalkWallpaperStore.oceanImage() {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Color.secondary.opacity(0.2)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private var customPreviewView: some View {
        if let customPreview {
            Image(uiImage: customPreview)
                .resizable()
                .scaledToFill()
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.primary.opacity(0.06))
                .overlay {
                    Image(systemName: "plus")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
        }
    }

    private func wallpaperOption(
        title: String,
        isSelected: Bool,
        preview: AnyView,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                preview
                    .frame(height: 72)
                    .frame(maxWidth: .infinity)
                    .overlay {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(isSelected ? Color.accentColor : Color.clear, lineWidth: 2)
                    }
                Text(title)
                    .font(OpenClawProFont.minimum.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
    }

    private func select(_ selection: TalkWallpaperSelection) {
        TalkWallpaperStore.setSelection(selection)
        self.wallpaperSelectionRaw = selection.rawValue
    }

    private func resetToDefault() {
        TalkWallpaperStore.clearCustomImage()
        self.customPreview = nil
        self.select(.default)
    }
}
