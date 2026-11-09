import CryptoKit
import Foundation

/// A target display expressed in the global CoreGraphics point space (top-left
/// origin), which is exactly the space CGEvent mouse coordinates use.
public struct OpenClawComputerDisplayGeometry: Sendable, Equatable {
    public var originX: Double
    public var originY: Double
    public var widthPoints: Double
    public var heightPoints: Double

    public init(originX: Double, originY: Double, widthPoints: Double, heightPoints: Double) {
        self.originX = originX
        self.originY = originY
        self.widthPoints = widthPoints
        self.heightPoints = heightPoints
    }
}

/// Maps captured screenshot pixels to global display points with a uniform
/// display-point-width / captured-pixel-width scale. Capture downsampling must
/// be reflected in that width; Retina backing scale must not enter CGEvent coordinates.
public enum OpenClawComputerInputGeometry {
    /// Screenshot and input paths derive the same identity so display, geometry,
    /// or reference-scale changes reject input targeting a stale frame.
    public static func displayFrameId(
        displayID: UInt32,
        sourceWidth: Double,
        sourceHeight: Double,
        referenceWidth: Int,
        display: OpenClawComputerDisplayGeometry) -> String
    {
        let descriptor = [
            String(displayID),
            String(sourceWidth.bitPattern),
            String(sourceHeight.bitPattern),
            String(referenceWidth),
            String(display.originX.bitPattern),
            String(display.originY.bitPattern),
            String(display.widthPoints.bitPattern),
            String(display.heightPoints.bitPattern),
        ].joined(separator: "\u{0}")
        let digest = SHA256.hash(data: Data(descriptor.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return "display-frame:v1:\(digest)"
    }

    /// Whether capture-source dimensions and their target display form a safe,
    /// finite coordinate mapping. Callers must reject invalid geometry before
    /// dispatching input; otherwise the fallback mapper collapses to an origin.
    public static func isValidMappingGeometry(
        sourceWidth: Double,
        sourceHeight: Double,
        display: OpenClawComputerDisplayGeometry) -> Bool
    {
        guard sourceWidth.isFinite,
              sourceHeight.isFinite,
              display.originX.isFinite,
              display.originY.isFinite,
              display.widthPoints.isFinite,
              display.heightPoints.isFinite
        else {
            return false
        }
        return sourceWidth > 0 &&
            sourceHeight > 0 &&
            display.widthPoints > 0 &&
            display.heightPoints > 0
    }

    /// The delivered screenshot pixel width for a reference width and the capture
    /// source dimensions. `sourceWidth`/`sourceHeight` are the capture source
    /// dimensions in the same units ScreenSnapshotService reads from the display.
    public static func capturedWidth(
        refWidth: Int?,
        sourceWidth: Double,
        sourceHeight: Double) -> Double
    {
        guard sourceWidth > 0 else { return 0 }
        // Node width cap: ScreenSnapshotService downscales the source to
        // min(refWidth, sourceWidth) and never upscales.
        let widthCap = refWidth.map { min(Double($0), sourceWidth) } ?? sourceWidth
        guard let refWidth, refWidth > 0, sourceHeight > 0 else { return widthCap }
        // The agent also caps the longest edge on delivery and replay. Mirror its
        // uniform portrait scaling so coordinates match the image the model saw.
        let cappedHeight = widthCap * sourceHeight / sourceWidth
        let longestEdge = max(widthCap, cappedHeight)
        let referenceWidth = Double(refWidth)
        guard longestEdge > referenceWidth else { return widthCap }
        return widthCap * referenceWidth / longestEdge
    }

    /// Converts a captured-pixel-space point to a global display point.
    /// `capturedWidthPixels` is the actual pixel width of the screenshot the
    /// model saw (see `capturedWidth`).
    public static func mapReferencePointToGlobal(
        x: Double,
        y: Double,
        capturedWidthPixels: Double,
        display: OpenClawComputerDisplayGeometry) -> (x: Double, y: Double)
    {
        guard capturedWidthPixels > 0, display.widthPoints > 0 else {
            return (x: display.originX, y: display.originY)
        }
        let scale = display.widthPoints / capturedWidthPixels
        return (
            x: display.originX + x * scale,
            y: display.originY + y * scale)
    }

    /// Keeps epsilon-tolerated edge coordinates inside the selected display;
    /// posting its exact far edge could click an adjacent screen the model never saw.
    public static func clampToDisplay(
        x: Double,
        y: Double,
        display: OpenClawComputerDisplayGeometry) -> (x: Double, y: Double)
    {
        let maxX = display.originX + max(0, display.widthPoints - 1)
        let maxY = display.originY + max(0, display.heightPoints - 1)
        return (
            x: min(max(x, display.originX), maxX),
            y: min(max(y, display.originY), maxY))
    }
}
