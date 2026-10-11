import AppKit
import Foundation
import OpenClawKit
@preconcurrency import ScreenCaptureKit

struct ScreenSnapshotResult: Sendable {
    let data: Data
    let format: OpenClawScreenSnapshotFormat
    let width: Int
    let height: Int
    let displayFrameId: String
}

@MainActor
enum ScreenCaptureSupport {
    static func requirePermission(failure: (String) -> any Error) throws {
        guard AppLaunchRuntimePlan.current.allowsActivation ||
            PermissionManager.screenRecordingPermissions.checkScreenRecordingPermission()
        else {
            throw failure("Screen Recording permission required; relaunch without --no-activate and retry")
        }
    }

    static func display(
        at index: Int?,
        noDisplays: any Error,
        invalidIndex: (Int) -> any Error) async throws -> SCDisplay
    {
        let content = try await SCShareableContent.current
        let displays = content.displays.sorted { $0.displayID < $1.displayID }
        guard !displays.isEmpty else { throw noDisplays }
        let index = index ?? 0
        guard displays.indices.contains(index) else { throw invalidIndex(index) }
        return displays[index]
    }
}

struct ScreenCaptureDisplayGeometry {
    let displayID: CGDirectDisplayID
    let geometry: OpenClawComputerDisplayGeometry
    let sourceWidth: Double
    let sourceHeight: Double

    init(display: SCDisplay, noDisplays: any Error) throws {
        let bounds = CGDisplayBounds(display.displayID)
        self.displayID = display.displayID
        self.geometry = OpenClawComputerDisplayGeometry(
            originX: bounds.origin.x,
            originY: bounds.origin.y,
            widthPoints: bounds.width,
            heightPoints: bounds.height)
        self.sourceWidth = Double(display.width)
        self.sourceHeight = Double(display.height)
        // A display can disappear after ScreenCaptureKit enumerates it.
        guard OpenClawComputerInputGeometry.isValidMappingGeometry(
            sourceWidth: self.sourceWidth,
            sourceHeight: self.sourceHeight,
            display: self.geometry)
        else { throw noDisplays }
    }

    func frameId(referenceWidth: Int) -> String {
        OpenClawComputerInputGeometry.displayFrameId(
            displayID: self.displayID,
            sourceWidth: self.sourceWidth,
            sourceHeight: self.sourceHeight,
            referenceWidth: referenceWidth,
            display: self.geometry)
    }
}

@MainActor
final class ScreenSnapshotService {
    enum ScreenSnapshotError: LocalizedError {
        case noDisplays
        case invalidScreenIndex(Int)
        case captureFailed(String)
        case encodeFailed(String)

        var errorDescription: String? {
            switch self {
            case .noDisplays:
                "No displays available for screen snapshot"
            case let .invalidScreenIndex(idx):
                "Invalid screen index \(idx)"
            case let .captureFailed(message), let .encodeFailed(message):
                message
            }
        }
    }

    func snapshot(
        screenIndex: Int?,
        maxWidth: Int?,
        quality: Double?,
        format: OpenClawScreenSnapshotFormat?) async throws
        -> ScreenSnapshotResult
    {
        try ScreenCaptureSupport.requirePermission(failure: ScreenSnapshotError.captureFailed)
        let format = format ?? .jpeg
        let maxWidth = maxWidth.flatMap { $0 > 0 ? $0 : nil } ?? (format == .png ? 900 : 1600)
        let quality = min(1.0, max(0.05, quality ?? 0.72))

        let display = try await ScreenCaptureSupport.display(
            at: screenIndex,
            noDisplays: ScreenSnapshotError.noDisplays,
            invalidIndex: ScreenSnapshotError.invalidScreenIndex)
        let displayFrameId = try Self.displayFrameId(
            for: display,
            referenceWidth: maxWidth)

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        let targetSize = Self.targetSize(
            width: display.width,
            height: display.height,
            maxWidth: maxWidth)
        config.width = targetSize.width
        config.height = targetSize.height
        config.showsCursor = true

        let cgImage: CGImage
        do {
            cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config)
        } catch {
            throw ScreenSnapshotError.captureFailed("screen capture failed")
        }
        // Geometry is part of the coordinate contract. If it changed while the
        // pixels were captured, no stable frame exists to authorize later input.
        let finalDisplayFrameId = try Self.displayFrameId(
            for: display,
            referenceWidth: maxWidth)
        guard displayFrameId == finalDisplayFrameId else {
            throw ScreenSnapshotError.captureFailed("display changed during screen capture")
        }

        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        let encoding: (NSBitmapImageRep.FileType, [NSBitmapImageRep.PropertyKey: Any]) = switch format {
        case .png: (.png, [:])
        case .jpeg: (.jpeg, [.compressionFactor: quality])
        }
        guard let data = bitmap.representation(
            using: encoding.0,
            properties: encoding.1)
        else {
            throw ScreenSnapshotError.encodeFailed("\(format.rawValue) encode failed")
        }

        return ScreenSnapshotResult(
            data: data,
            format: format,
            width: cgImage.width,
            height: cgImage.height,
            displayFrameId: displayFrameId)
    }

    private static func displayFrameId(
        for display: SCDisplay,
        referenceWidth: Int) throws -> String
    {
        try ScreenCaptureDisplayGeometry(display: display, noDisplays: ScreenSnapshotError.noDisplays)
            .frameId(referenceWidth: referenceWidth)
    }

    private static func targetSize(width: Int, height: Int, maxWidth: Int) -> (width: Int, height: Int) {
        guard width > 0, height > 0, width > maxWidth else {
            return (width: width, height: height)
        }
        let scale = Double(maxWidth) / Double(width)
        let targetHeight = max(1, Int((Double(height) * scale).rounded()))
        return (width: maxWidth, height: targetHeight)
    }
}
