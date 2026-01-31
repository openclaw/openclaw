import Foundation
import Photos
import OpenClawKit
import UIKit

final class PhotoLibraryService: PhotosServicing {
    func latest(params: OpenClawPhotosLatestParams) async throws -> OpenClawPhotosLatestPayload {
        let status = await Self.ensureAuthorization()
        guard status == .authorized || status == .limited else {
            throw NSError(domain: "Photos", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "PHOTOS_PERMISSION_REQUIRED: grant Photos permission",
            ])
        }

        let limit = max(1, min(params.limit ?? 1, 20))
        let fetchOptions = PHFetchOptions()
        fetchOptions.fetchLimit = limit
        fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let assets = PHAsset.fetchAssets(with: .image, options: fetchOptions)

        var results: [OpenClawPhotoPayload] = []
        let maxWidth = params.maxWidth.flatMap { $0 > 0 ? $0 : nil } ?? 1600
        let quality = params.quality.map { max(0.1, min(1.0, $0)) } ?? 0.85
        let formatter = ISO8601DateFormatter()

        assets.enumerateObjects { asset, _, stop in
            if results.count >= limit { stop.pointee = true; return }
            if let payload = try? Self.renderAsset(
                asset,
                maxWidth: maxWidth,
                quality: quality,
                formatter: formatter)
            {
                results.append(payload)
            }
        }

        return OpenClawPhotosLatestPayload(photos: results)
    }

    private static func ensureAuthorization() async -> PHAuthorizationStatus {
        let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if current == .notDetermined {
            return await withCheckedContinuation { cont in
                PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                    cont.resume(returning: status)
                }
            }
        }
        return current
    }

    private static func renderAsset(
        _ asset: PHAsset,
        maxWidth: Int,
        quality: Double,
        formatter: ISO8601DateFormatter) throws -> OpenClawPhotoPayload
    {
        let manager = PHImageManager.default()
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat

        let targetSize: CGSize = {
            guard maxWidth > 0 else { return PHImageManagerMaximumSize }
            let aspect = CGFloat(asset.pixelHeight) / CGFloat(max(1, asset.pixelWidth))
            let width = CGFloat(maxWidth)
            return CGSize(width: width, height: width * aspect)
        }()

        var image: UIImage?
        manager.requestImage(
            for: asset,
            targetSize: targetSize,
            contentMode: .aspectFit,
            options: options)
        { result, _ in
            image = result
        }

        guard let image else {
            throw NSError(domain: "Photos", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "photo load failed",
            ])
        }

        let jpeg = image.jpegData(compressionQuality: quality)
        guard let data = jpeg else {
            throw NSError(domain: "Photos", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "photo encode failed",
            ])
        }

        let created = asset.creationDate.map { formatter.string(from: $0) }
        return OpenClawPhotoPayload(
            format: "jpeg",
            base64: data.base64EncodedString(),
            width: Int(image.size.width),
            height: Int(image.size.height),
            createdAt: created)
    }
}
