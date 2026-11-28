#if os(iOS)
import Photos
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The newest photos and videos in the library for the "+" sheet's photo row. Nothing is read before the person has
/// allowed
/// access; asking happens only when they tap the row's card.
@MainActor
@Observable
final class ChatRecentPhotosLibrary {
    enum Access: Equatable {
        case notDetermined
        case full
        case limited
        case denied
        /// Screen Time or device management: the person can't grant access in Settings.
        case restricted
    }

    private(set) var access: Access
    private(set) var assets: [PHAsset] = []
    @ObservationIgnored let imageManager = PHCachingImageManager()

    static let limit = 24

    init() {
        self.access = Self.currentAccess()
        self.reload()
    }

    func refresh() {
        self.access = Self.currentAccess()
        self.reload()
    }

    /// The system prompt. Read and write is the only level that lets an app read photos; nothing is written.
    func requestAccess() {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { @Sendable _ in
            Task { @MainActor in self.refresh() }
        }
    }

    /// The system's own sheet for changing which photos a limited grant covers.
    func chooseMorePhotos() {
        guard let presenter = Self.topViewController() else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: presenter) { @Sendable _ in
            Task { @MainActor in self.refresh() }
        }
    }

    private func reload() {
        guard self.access == .full || self.access == .limited else {
            self.assets = []
            return
        }
        let options = PHFetchOptions()
        options.fetchLimit = Self.limit
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.predicate = NSPredicate(
            format: "mediaType IN %@",
            [PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue])
        let result = PHAsset.fetchAssets(with: options)
        var assets: [PHAsset] = []
        result.enumerateObjects { asset, _, _ in assets.append(asset) }
        self.assets = assets
    }

    private static func currentAccess() -> Access {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .notDetermined: .notDetermined
        case .authorized: .full
        case .limited: .limited
        case .denied: .denied
        case .restricted: .restricted
        @unknown default: .denied
        }
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var top = scene?.keyWindow?.rootViewController
        while let next = top?.presentedViewController {
            top = next
        }
        return top
    }
}

/// A recent asset, staged through the same tile and attachment pipeline as a Photos pick.
@MainActor
struct OpenClawRecentPhotoPick {
    let asset: PHAsset
    let baseName: String
    let preparation: UUID?

    func load(owner: OpenClawChatAttachmentCaptureOwner) async {
        if self.asset.mediaType == .video {
            let resources = PHAssetResource.assetResources(for: self.asset)
            // Prefer the current (edited) movie. Live Photos remain ordinary photos in this row.
            guard let resource = resources.first(where: { $0.type == .fullSizeVideo })
                ?? resources.first(where: { $0.type == .video })
            else { self.reportLoadFailure(owner)
                return
            }
            let type = UTType(resource.uniformTypeIdentifier) ?? .movie
            let metadata = OpenClawChatPickerAttachmentMetadata.resolve(contentType: type)
            let name = "\(self.baseName).\(metadata.fileExtension)"
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(metadata.fileExtension)
            defer { try? FileManager.default.removeItem(at: url) }
            let options = PHAssetResourceRequestOptions()
            options.isNetworkAccessAllowed = true
            do {
                try await PHAssetResourceManager.default().writeData(for: resource, toFile: url, options: options)
                await owner.viewModel.addVideoAttachment(
                    url: url,
                    fileName: name,
                    mimeType: metadata.mimeType,
                    expectedSession: owner.session,
                    preparation: self.preparation)
            } catch {
                self.reportLoadFailure(owner)
            }
            return
        }
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.version = .current
        let (data, typeIdentifier) = await withCheckedContinuation { continuation in
            typealias Handler = @Sendable (Data?, String?, CGImagePropertyOrientation, [AnyHashable: Any]?) -> Void
            let done: Handler = { data, typeIdentifier, _, _ in
                continuation.resume(returning: (data, typeIdentifier))
            }
            PHImageManager.default().requestImageDataAndOrientation(
                for: self.asset,
                options: options,
                resultHandler: done)
        }
        guard owner.viewModel.isCurrentSession(owner.session) else { return }
        guard let data else {
            self.reportLoadFailure(owner)
            return
        }
        let type = typeIdentifier.flatMap(UTType.init) ?? .jpeg
        let metadata = OpenClawChatPickerAttachmentMetadata.resolve(contentType: type)
        await owner.viewModel.addImageAttachment(
            data: data,
            fileName: "\(self.baseName).\(metadata.fileExtension)",
            mimeType: metadata.mimeType,
            for: owner.session,
            preparation: self.preparation)
    }

    private func reportLoadFailure(_ owner: OpenClawChatAttachmentCaptureOwner) {
        guard owner.viewModel.isCurrentSession(owner.session) else { return }
        owner.viewModel.reportAttachmentFailure(
            String(localized: "Couldn’t load this attachment. Try again."),
            preparation: self.preparation,
            transient: true)
    }
}

extension OpenClawChatViewModel {
    /// Stages photos and videos from the "+" sheet's row: each gets its tile at once, then loads in the order picked.
    func addRecentPhotos(_ assets: [PHAsset], owner: OpenClawChatAttachmentCaptureOwner) {
        let picks = assets.map { asset in
            let video = asset.mediaType == .video
            let metadata = OpenClawChatPickerAttachmentMetadata.resolve(contentType: video ? .movie : .jpeg)
            let baseName = OpenClawChatGeneratedAttachmentName.picked(video ? .video : .photo)
            let preparation = self.beginAttachmentPreparation(
                fileName: "\(baseName).\(metadata.fileExtension)",
                mimeType: metadata.mimeType)
            let pick = OpenClawRecentPhotoPick(asset: asset, baseName: baseName, preparation: preparation)
            self.setAttachmentPreparationReload(preparation) { await pick.load(owner: owner) }
            return pick
        }
        self.runAttachmentPreparation(picks.map(\.preparation)) { @MainActor in
            for pick in picks {
                guard self.isCurrentSession(owner.session) else { break }
                guard !self.isAttachmentPreparationRemoved(pick.preparation) else { continue }
                await pick.load(owner: owner)
            }
        }
    }
}

/// Quiet metadata over a movie's poster, never part of the tile's measured layout.
struct ChatVideoDurationLabel: View {
    let seconds: TimeInterval

    static func clock(_ seconds: TimeInterval) -> String {
        let whole = seconds.rounded(.down)
        return Duration.seconds(whole).formatted(.time(pattern: whole < 3600 ? .minuteSecond : .hourMinuteSecond))
    }

    var body: some View {
        Text(verbatim: Self.clock(self.seconds))
            .font(OpenClawChatTypography.caption2.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.9), radius: 1, y: 0.5)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .accessibilityHidden(true)
            .allowsHitTesting(false)
    }
}

/// An asset's thumbnail, requested at the tile's pixel size.
struct ChatRecentPhotoThumbnail: View {
    let asset: PHAsset
    let manager: PHCachingImageManager
    let side: CGFloat
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    var body: some View {
        Color(uiColor: .secondarySystemFill)
            .overlay {
                if let image = self.image {
                    Image(uiImage: image).resizable().scaledToFill()
                }
            }
            .clipped()
            .task(id: self.asset.localIdentifier) {
                let options = PHImageRequestOptions()
                options.deliveryMode = .highQualityFormat
                options.resizeMode = .fast
                options.isNetworkAccessAllowed = true
                let pixels = self.side * self.displayScale
                self.image = await withCheckedContinuation { continuation in
                    self.manager.requestImage(
                        for: self.asset,
                        targetSize: CGSize(width: pixels, height: pixels),
                        contentMode: .aspectFill,
                        options: options)
                    { @Sendable image, _ in
                        continuation.resume(returning: image)
                    }
                }
            }
    }
}
#endif
