import SwiftUI

#if os(iOS)
import UIKit
#endif

/// Geometry shared with the web lightbox (ui/src/components/image-lightbox-content.tsx):
/// open fitted, zoom up to 4x the fit, double-tap toggles 2.5x.
enum ChatImagePreviewLayout {
    static let closeHitSize: CGFloat = 44
    static let maximumZoomMultiplier: CGFloat = 4
    static let doubleTapZoomMultiplier: CGFloat = 2.5

    /// Aspect-fit scale that keeps the whole image visible. Like the web's
    /// `max-width/max-height: 100%`, small images are not upscaled.
    static func fitScale(imageSize: CGSize, boundsSize: CGSize) -> CGFloat {
        guard imageSize.width > 0, imageSize.height > 0, boundsSize.width > 0, boundsSize.height > 0
        else { return 1 }
        return min(1, boundsSize.width / imageSize.width, boundsSize.height / imageSize.height)
    }
}

@MainActor
public struct ChatMediaImagePreview: View {
    let image: OpenClawPlatformImage
    let onClose: @MainActor () -> Void

    public init(image: OpenClawPlatformImage, onClose: @escaping @MainActor () -> Void) {
        self.image = image
        self.onClose = onClose
    }

    public var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            #if os(iOS)
            // Fit inside the safe area; zoomed content may still scroll under the bars.
            GeometryReader { proxy in
                ChatZoomableImageView(image: self.image, safeArea: proxy.safeAreaInsets)
                    .ignoresSafeArea()
            }
            #else
            OpenClawPlatformImageFactory.image(self.image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(20)
            #endif
            ChatImagePreviewCloseButton(action: self.onClose)
                .padding(8)
        }
        .accessibilityAction(.escape) { self.onClose() }
        #if os(macOS)
        .frame(minWidth: 500, idealWidth: 900, minHeight: 350, idealHeight: 600)
        .presentationSizing(.fitted)
        #endif
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
        #if os(macOS)
        .keyboardShortcut(.cancelAction)
        #endif
    }
}

#if os(iOS)
private struct ChatZoomableImageView: UIViewRepresentable {
    let image: UIImage
    let safeArea: EdgeInsets

    func makeUIView(context: Context) -> ChatZoomableImageScrollView {
        ChatZoomableImageScrollView(image: self.image)
    }

    func updateUIView(_ view: ChatZoomableImageScrollView, context: Context) {
        view.viewportInsets = UIEdgeInsets(
            top: self.safeArea.top,
            left: self.safeArea.leading,
            bottom: self.safeArea.bottom,
            right: self.safeArea.trailing)
    }
}

/// Native pinch, pan, and double-tap zoom, with the image centered while it is smaller than the view.
final class ChatZoomableImageScrollView: UIScrollView, UIScrollViewDelegate {
    let imageView: UIImageView
    /// Unobstructed region (safe area) that the fitted image must stay inside.
    var viewportInsets: UIEdgeInsets = .zero {
        didSet { if self.viewportInsets != oldValue { self.fitImage() } }
    }

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

    init(image: UIImage) {
        self.imageView = UIImageView(image: image)
        super.init(frame: .zero)
        self.delegate = self
        self.backgroundColor = .clear
        self.showsHorizontalScrollIndicator = false
        self.showsVerticalScrollIndicator = false
        self.contentInsetAdjustmentBehavior = .never
        self.decelerationRate = .fast
        self.imageView.frame = CGRect(origin: .zero, size: image.size)
        self.imageView.accessibilityIgnoresInvertColors = true
        self.addSubview(self.imageView)
        self.contentSize = image.size
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(self.toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        self.addGestureRecognizer(doubleTap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard self.bounds.size != self.fittedBoundsSize || self.resizeAnchor != nil else { return }
        self.fitImage()
    }

    /// Refit after a size or safe-area change. A fitted image stays fitted; a zoomed one keeps
    /// its zoom relative to the fit and the image point at the center of the view.
    func fitImage() {
        let fit = ChatImagePreviewLayout.fitScale(
            imageSize: self.imageView.bounds.size,
            boundsSize: self.bounds.inset(by: self.viewportInsets).size)
        let relativeZoom = self.zoomScale / self.minimumZoomScale
        let anchor = self.resizeAnchor ?? self.convert(
            CGPoint(x: self.bounds.midX, y: self.bounds.midY), to: self.imageView)
        // Consume before zoom/inset callbacks; same-size refits must use the current pan.
        self.resizeAnchor = nil
        self.fittedBoundsSize = self.bounds.size
        // Raise the ceiling before the floor so min never exceeds max.
        self.maximumZoomScale = max(self.maximumZoomScale, fit * ChatImagePreviewLayout.maximumZoomMultiplier)
        self.minimumZoomScale = fit
        self.maximumZoomScale = fit * ChatImagePreviewLayout.maximumZoomMultiplier
        guard relativeZoom > 1.01 else {
            self.zoomScale = fit
            self.centerImage()
            self.contentOffset = CGPoint(x: -self.contentInset.left, y: -self.contentInset.top)
            return
        }
        self.zoomScale = min(fit * relativeZoom, self.maximumZoomScale)
        self.centerImage()
        let maxOffset = CGPoint(
            x: self.contentSize.width + self.contentInset.right - self.bounds.width,
            y: self.contentSize.height + self.contentInset.bottom - self.bounds.height)
        self.contentOffset = CGPoint(
            x: min(max(anchor.x * self.zoomScale - self.bounds.width / 2, -self.contentInset.left), maxOffset.x),
            y: min(max(anchor.y * self.zoomScale - self.bounds.height / 2, -self.contentInset.top), maxOffset.y))
    }

    private func centerImage() {
        let viewport = self.viewportInsets
        let horizontal = max(0, (self.bounds.width - viewport.left - viewport.right - self.contentSize.width) / 2)
        let vertical = max(0, (self.bounds.height - viewport.top - viewport.bottom - self.contentSize.height) / 2)
        self.contentInset = UIEdgeInsets(
            top: viewport.top + vertical,
            left: viewport.left + horizontal,
            bottom: viewport.bottom + vertical,
            right: viewport.right + horizontal)
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
        self.centerImage()
    }
}
#endif
