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
                ProCard(radius: SettingsLayout.cardRadius) {
                    LazyVGrid(
                        columns: [
                            GridItem(.flexible(), spacing: 12),
                            GridItem(.flexible(), spacing: 12),
                        ],
                        spacing: 12)
                    {
                        self.wallpaperOption(
                            isSelected: self.selection == .default,
                            preview: AnyView(self.defaultPreview))
                        {
                            self.select(.default)
                        }

                        self.wallpaperOption(
                            isSelected: self.selection == .custom,
                            preview: AnyView(self.customPreviewView))
                        {
                            if TalkWallpaperStore.hasCustomImage() {
                                self.select(.custom)
                            }
                        }
                    }
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
                .padding(.top, 18)
                .padding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
        }
        .navigationTitle("Call Background")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                PhotosPicker(selection: self.$selectedPhoto, matching: .images) {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add background")
            }
        }
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
                do {
                    try TalkWallpaperStore.saveCustomImage(jpeg)
                } catch {
                    return
                }
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

    @ViewBuilder
    private var customPreviewView: some View {
        if let customPreview {
            Image(uiImage: customPreview)
                .resizable()
                .scaledToFill()
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
        isSelected: Bool,
        preview: AnyView,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            preview
                .frame(maxWidth: .infinity)
                .frame(height: 72)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(isSelected ? OpenClawBrand.accent : Color.clear, lineWidth: 2)
                }
        }
        .buttonStyle(.plain)
    }

    private func select(_ selection: TalkWallpaperSelection) {
        TalkWallpaperStore.setSelection(selection)
        self.wallpaperSelectionRaw = selection.rawValue
    }
}
