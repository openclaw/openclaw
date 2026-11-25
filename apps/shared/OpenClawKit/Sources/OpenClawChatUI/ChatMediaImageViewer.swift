import SwiftUI

#if os(iOS)
import UIKit
#endif

/// Geometry of the image viewer. The zoom range follows the web lightbox
/// (ui/src/components/image-lightbox-content.tsx): up to 4x the fit, double-tap toggles 2.5x.
/// On iPhone the image opens edge to edge, like Photos, instead of the web's no-upscale rule.
enum ChatImagePreviewLayout {
    static let closeHitSize: CGFloat = 44
    static let maximumZoomMultiplier: CGFloat = 4
    static let doubleTapZoomMultiplier: CGFloat = 2.5
    /// The deepest zoom also reaches two screen pixels per image pixel, so a large original
    /// can be read even when 4x its fit is still smaller than its pixels.
    static let maximumScreenPixelsPerImagePixel: CGFloat = 2

    /// Aspect fit to the whole view: the image touches both edges of its constrained axis.
    /// Small images grow to fit, as in Photos.
    static func fitScale(imageSize: CGSize, boundsSize: CGSize) -> CGFloat {
        guard imageSize.width > 0, imageSize.height > 0, boundsSize.width > 0, boundsSize.height > 0
        else { return 1 }
        return min(boundsSize.width / imageSize.width, boundsSize.height / imageSize.height)
    }

    static func maximumZoomScale(fitScale: CGFloat, displayScale: CGFloat) -> CGFloat {
        max(
            fitScale * self.maximumZoomMultiplier,
            self.maximumScreenPixelsPerImagePixel / max(displayScale, 1))
    }

    /// Leading inset of content along one axis. Content that fits between the bars is centered
    /// there; content that does not slides toward the view's edges, continuously, so zooming
    /// never jumps; content longer than the view scrolls from its edge.
    static func restingInset(
        content: CGFloat,
        bounds: CGFloat,
        obstructedLeading: CGFloat,
        obstructedTrailing: CGFloat) -> CGFloat
    {
        guard content < bounds else { return 0 }
        let band = bounds - obstructedLeading - obstructedTrailing
        let centeredInBand = obstructedLeading + (band - content) / 2
        return max(0, min(centeredInBand, bounds - content))
    }
}

#if os(macOS)
@MainActor
struct ChatMediaImagePreview: View {
    let image: OpenClawPlatformImage
    let onClose: @MainActor () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            OpenClawPlatformImageFactory.image(self.image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(20)
            ChatImagePreviewCloseButton(action: self.onClose)
                .padding(8)
        }
        .accessibilityAction(.escape) { self.onClose() }
        .frame(minWidth: 500, idealWidth: 900, minHeight: 350, idealHeight: 600)
        .presentationSizing(.fitted)
    }
}

@MainActor
struct ChatImagePreviewCloseButton: View {
    let action: @MainActor () -> Void

    var body: some View {
        Button {
            self.action()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Color.black.opacity(0.55)))
                .frame(width: ChatImagePreviewLayout.closeHitSize, height: ChatImagePreviewLayout.closeHitSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(String(localized: "Close image preview"))
        .keyboardShortcut(.cancelAction)
    }
}
#endif

#if os(iOS)
/// Native pinch, pan, and double-tap zoom over one image.
///
/// The image view keeps the original's pixel size (`pixelSize`), so a thumbnail can stand in
/// while the full image loads and `setImage` sharpens it in place without moving anything.
final class ChatZoomableImageScrollView: UIScrollView, UIScrollViewDelegate {
    let imageView: UIImageView
    /// Edges covered by chrome (the top bar, the home indicator). A fitted image rests clear of
    /// them when it fits between them; it never shrinks to avoid them.
    var obstructedInsets: UIEdgeInsets = .zero {
        didSet { if self.obstructedInsets != oldValue { self.fitImage() } }
    }

    /// Called with `true` when the image leaves its fitted size and `false` when it returns.
    var onZoomedChange: ((Bool) -> Void)?
    private(set) var isZoomed = false
    let doubleTapRecognizer: UITapGestureRecognizer

    private var fittedBoundsSize: CGSize = .zero
    private var resizeAnchor: CGPoint?

    override var frame: CGRect {
        willSet { self.captureResizeAnchor(from: self.frame.size, to: newValue.size) }
    }

    override var bounds: CGRect {
        willSet { self.captureResizeAnchor(from: self.bounds.size, to: newValue.size) }
    }

    /// UIKit can clamp the old offset inside either size setter, before layout runs.
    /// Retain the first pre-resize point across nested setters or queued size changes.
    private func captureResizeAnchor(from oldSize: CGSize, to newSize: CGSize) {
        guard oldSize != newSize, self.resizeAnchor == nil, self.fittedBoundsSize != .zero else { return }
        self.resizeAnchor = self.convert(CGPoint(x: self.bounds.midX, y: self.bounds.midY), to: self.imageView)
    }

    convenience init(image: UIImage) {
        self.init(image: image, pixelSize: CGSize(
            width: image.size.width * image.scale,
            height: image.size.height * image.scale))
    }

    init(image: UIImage?, pixelSize: CGSize) {
        self.imageView = UIImageView(image: image)
        self.doubleTapRecognizer = UITapGestureRecognizer()
        super.init(frame: .zero)
        self.delegate = self
        self.backgroundColor = .clear
        self.showsHorizontalScrollIndicator = false
        self.showsVerticalScrollIndicator = false
        self.contentInsetAdjustmentBehavior = .never
        self.decelerationRate = .fast
        if #available(iOS 26.0, *) {
            // The image runs edge to edge; no bar sits on it while it is zoomed.
            for effect in [self.topEdgeEffect, self.bottomEdgeEffect, self.leftEdgeEffect, self.rightEdgeEffect] {
                effect.isHidden = true
            }
        }
        self.imageView.contentMode = .scaleToFill
        self.imageView.frame = CGRect(origin: .zero, size: pixelSize)
        self.imageView.accessibilityIgnoresInvertColors = true
        self.addSubview(self.imageView)
        self.contentSize = pixelSize
        self.doubleTapRecognizer.addTarget(self, action: #selector(self.toggleZoom(_:)))
        self.doubleTapRecognizer.numberOfTapsRequired = 2
        self.addGestureRecognizer(self.doubleTapRecognizer)
        // The zoom ceiling depends on the screen's pixel density, known once in a window.
        self.registerForTraitChanges([UITraitDisplayScale.self]) { (view: Self, _) in view.fitImage() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Swaps in a sharper copy of the same image. Its aspect must match `pixelSize`.
    func setImage(_ image: UIImage) {
        self.imageView.image = image
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard self.bounds.size != self.fittedBoundsSize || self.resizeAnchor != nil else { return }
        self.fitImage()
    }

    /// Refit after a size or inset change. A fitted image stays fitted; a zoomed one keeps
    /// its zoom relative to the fit and the image point at the center of the view.
    func fitImage() {
        guard self.bounds.size.width > 0, self.bounds.size.height > 0 else { return }
        let fit = ChatImagePreviewLayout.fitScale(
            imageSize: self.imageView.bounds.size,
            boundsSize: self.bounds.size)
        let relativeZoom = self.zoomScale / self.minimumZoomScale
        let anchor = self.resizeAnchor ?? self.convert(
            CGPoint(x: self.bounds.midX, y: self.bounds.midY), to: self.imageView)
        // Consume before zoom/inset callbacks; same-size refits must use the current pan.
        self.resizeAnchor = nil
        self.fittedBoundsSize = self.bounds.size
        let maximum = ChatImagePreviewLayout.maximumZoomScale(
            fitScale: fit,
            displayScale: self.traitCollection.displayScale)
        // Raise the ceiling before the floor so min never exceeds max.
        self.maximumZoomScale = max(self.maximumZoomScale, maximum)
        self.minimumZoomScale = fit
        self.maximumZoomScale = maximum
        guard relativeZoom > 1.01 else {
            self.zoomScale = fit
            self.restImage()
            self.contentOffset = CGPoint(x: -self.contentInset.left, y: -self.contentInset.top)
            return
        }
        self.zoomScale = min(fit * relativeZoom, self.maximumZoomScale)
        self.restImage()
        let maxOffset = CGPoint(
            x: self.contentSize.width + self.contentInset.right - self.bounds.width,
            y: self.contentSize.height + self.contentInset.bottom - self.bounds.height)
        self.contentOffset = CGPoint(
            x: min(max(anchor.x * self.zoomScale - self.bounds.width / 2, -self.contentInset.left), maxOffset.x),
            y: min(max(anchor.y * self.zoomScale - self.bounds.height / 2, -self.contentInset.top), maxOffset.y))
    }

    /// Places content smaller than the view: clear of the bars when it fits between them,
    /// otherwise as close to that as the view allows.
    private func restImage() {
        let obstructed = self.obstructedInsets
        let content = self.contentSize
        let top = ChatImagePreviewLayout.restingInset(
            content: content.height,
            bounds: self.bounds.height,
            obstructedLeading: obstructed.top,
            obstructedTrailing: obstructed.bottom)
        let left = ChatImagePreviewLayout.restingInset(
            content: content.width,
            bounds: self.bounds.width,
            obstructedLeading: obstructed.left,
            obstructedTrailing: obstructed.right)
        self.contentInset = UIEdgeInsets(
            top: top,
            left: left,
            bottom: max(0, self.bounds.height - content.height - top),
            right: max(0, self.bounds.width - content.width - left))
        let zoomed = self.zoomScale > self.minimumZoomScale * 1.01
        if zoomed != self.isZoomed {
            self.isZoomed = zoomed
            self.onZoomedChange?(zoomed)
        }
    }

    @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
        if self.zoomScale > self.minimumZoomScale * 1.01 {
            self.setZoomScale(self.minimumZoomScale, animated: true)
            return
        }
        let scale = min(
            self.minimumZoomScale * ChatImagePreviewLayout.doubleTapZoomMultiplier,
            self.maximumZoomScale)
        let point = gesture.location(in: self.imageView)
        let size = CGSize(width: self.bounds.width / scale, height: self.bounds.height / scale)
        self.zoom(
            to: CGRect(
                x: point.x - size.width / 2,
                y: point.y - size.height / 2,
                width: size.width,
                height: size.height),
            animated: true)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        self.imageView
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        self.restImage()
    }
}
#endif
