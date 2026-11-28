import Foundation
import SwiftUI

#if os(iOS)
import UIKit
#endif

/// One image of a message, in transcript order, as the full-screen viewer pages through it.
struct ChatImageViewerItem: Equatable {
    /// Largest side the viewer decodes. Bigger originals are downsampled to bound memory.
    static let maximumPixelSize = 4096

    let artifactId: String
    /// VoiceOver label: the alt text, else the file name.
    let label: String
    /// Shown in the viewer's bar: the file name, when the message has one the person chose.
    let title: String?
    /// The original's pixel size from the message, when the Gateway sent it.
    let pixelSize: CGSize?

    /// The message's images that can be fetched, in order. A user's message also pages through its
    /// sent photos, keyed as their transcript tiles are (`ChatUserImageSource.pageID`).
    static func gallery(in contents: [OpenClawChatMessageContent], sentPhotos: Bool = false) -> [ChatImageViewerItem] {
        contents.compactMap { content in
            guard content.mediaKind == .image else { return nil }
            let managedID = content.artifactId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var artifactId = OpenClawChatMediaKind.image.acceptsManagedArtifactID(managedID) ? managedID : ""
            #if os(iOS)
            if sentPhotos, artifactId.isEmpty { artifactId = ChatUserImageSource.pageID(content) ?? "" }
            #endif
            guard !artifactId.isEmpty else { return nil }
            let isSentPhoto = artifactId != managedID
            let alt = Self.nonEmpty(content.alt)
            let fileName = Self.nonEmpty(content.fileName)
            let pixelSize: CGSize? = if let width = content.width, let height = content.height,
                                        width > 0, height > 0
            {
                CGSize(width: width, height: height)
            } else {
                nil
            }
            return ChatImageViewerItem(
                artifactId: artifactId,
                // A sent photo's name is the picker's ("photo-1A2B.jpg"), not something to read aloud.
                label: alt ?? (isSentPhoto ? String(localized: "Photo") : fileName ?? String(localized: "Attachment")),
                // Agent replies carry the file name as alt text ("chart.png"); a description is not a name.
                // A name the app made up for a sent photo names nothing, so the bar shows none.
                title: (fileName ?? alt.flatMap { Self.looksLikeFileName($0) ? $0 : nil })
                    .flatMap { isSentPhoto && OpenClawChatGeneratedAttachmentName.isGenerated($0) ? nil : $0 },
                pixelSize: pixelSize)
        }
    }

    /// The pages for a tap on `artifactId`: the message's images, or that image alone when the
    /// caller passed no gallery.
    static func viewerItems(
        _ gallery: [ChatImageViewerItem],
        opening artifactId: String,
        label: String) -> [ChatImageViewerItem]
    {
        guard !gallery.contains(where: { $0.artifactId == artifactId }) else { return gallery }
        return [ChatImageViewerItem(artifactId: artifactId, label: label, title: nil, pixelSize: nil)]
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    static func looksLikeFileName(_ value: String) -> Bool {
        value.range(of: #"^[^\s/\\]+\.[A-Za-z0-9]{2,5}$"#, options: .regularExpression) != nil
    }

    /// Pixel size the viewer lays the image out at: the original's, capped at `maximumPixelSize`.
    static func displayPixelSize(_ size: CGSize) -> CGSize {
        let longest = max(size.width, size.height)
        let cap = CGFloat(self.maximumPixelSize)
        guard longest > cap else { return size }
        return CGSize(width: size.width * cap / longest, height: size.height * cap / longest)
    }

    /// Whether `thumbnail` already holds every pixel the viewer would show.
    static func thumbnailIsFullResolution(thumbnailPixelSize: CGSize, originalPixelSize: CGSize?) -> Bool {
        let thumbnailLongest = max(thumbnailPixelSize.width, thumbnailPixelSize.height)
        guard let originalPixelSize else {
            // The transcript decoder stops at its own cap; anything smaller is the original.
            return thumbnailLongest < CGFloat(ChatMediaImageDecoder.maximumThumbnailPixels)
        }
        let display = self.displayPixelSize(originalPixelSize)
        return thumbnailLongest >= max(display.width, display.height) - 1
    }

    /// "2 of 3" for a message with several images; nothing for one.
    static func positionText(index: Int, count: Int) -> String? {
        guard count > 1, index >= 0, index < count else { return nil }
        return String(format: String(localized: "%lld of %lld"), Int64(index + 1), Int64(count))
    }
}

#if os(iOS)
/// Transcript thumbnails by artifact, so the viewer can grow from and return to the one on screen.
/// Weak: a thumbnail scrolled out of the list simply stops being a zoom source.
@MainActor
enum ChatImageViewerSources {
    private static let views = NSMapTable<NSString, UIImageView>.strongToWeakObjects()

    static func register(_ view: UIImageView, for artifactId: String) {
        self.views.setObject(view, forKey: artifactId as NSString)
    }

    static func view(for artifactId: String) -> UIImageView? {
        guard let view = self.views.object(forKey: artifactId as NSString), view.window != nil else { return nil }
        return view
    }
}

/// The transcript thumbnail. A UIKit image view, because the system zoom transition grows the
/// viewer out of a real view and hides that view while the viewer covers it.
struct ChatImageViewerThumbnail: UIViewRepresentable {
    /// The bubble's corner, so the thumbnail and its reserved box share one outline.
    static let cornerRadius: CGFloat = 16

    let image: UIImage
    let artifactId: String
    /// Fill the proposed box (the transcript's reserved box) instead of the image's own aspect.
    var fillsProposal = false

    func makeUIView(context: Context) -> UIImageView {
        let view = UIImageView()
        view.contentMode = .scaleAspectFill
        view.clipsToBounds = true
        view.layer.cornerRadius = Self.cornerRadius
        view.layer.cornerCurve = .continuous
        view.accessibilityIgnoresInvertColors = true
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .vertical)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        return view
    }

    func updateUIView(_ view: UIImageView, context: Context) {
        view.image = self.image
        ChatImageViewerSources.register(view, for: self.artifactId)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIImageView, context: Context) -> CGSize? {
        let size = self.image.size
        guard size.width > 0, size.height > 0 else { return .zero }
        if self.fillsProposal, let width = proposal.width, let height = proposal.height {
            return CGSize(width: width, height: height)
        }
        let width = proposal.width ?? size.width
        let height = proposal.height ?? size.height
        let scale = min(width / size.width, height / size.height)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }
}

/// What the bar shows. The controller owns it; the SwiftUI bar draws it.
@MainActor
@Observable
final class ChatImageViewerChrome {
    var title: String?
    var position: String?
    var shareImage: UIImage?
    var shareName = ""
    var isHidden = false
    /// The message's images for the row of thumbnails, in page order; nil while a thumbnail's
    /// pixels are not in hand. Empty for a single image, which has no row.
    var strip: [UIImage?] = []
    var stripIndex = 0
    @ObservationIgnored var close: () -> Void = {}
    @ObservationIgnored var selectStrip: (Int) -> Void = { _ in }
}

/// Round close at the leading edge, the name and position in the middle, Share at the trailing edge.
struct ChatImageViewerBar: View {
    let chrome: ChatImageViewerChrome

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Button {
                self.chrome.close()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: ChatImagePreviewLayout.closeHitSize, height: ChatImagePreviewLayout.closeHitSize)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .modifier(ChatImageViewerGlass())
            .accessibilityLabel(String(localized: "Close"))
            .accessibilityIdentifier("chat-image-viewer-close")

            VStack(spacing: 1) {
                if let title = self.chrome.title {
                    Text(title)
                        .font(OpenClawChatTypography.headline)
                        .foregroundStyle(OpenClawChatTheme.assistantText)
                        // Wraps at large text sizes instead of hiding most of the name.
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .multilineTextAlignment(.center)
                }
                if let position = self.chrome.position {
                    Text(position)
                        .font(OpenClawChatTypography.footnote)
                        // Opaque secondary ink: a translucent label loses contrast over an image.
                        .foregroundStyle(OpenClawChatTheme.muted)
                        .lineLimit(1)
                        .accessibilityIdentifier("chat-image-viewer-position")
                }
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)

            if let image = self.chrome.shareImage {
                ShareLink(
                    item: Image(uiImage: image),
                    preview: SharePreview(self.chrome.shareName, image: Image(uiImage: image)))
                {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(
                            width: ChatImagePreviewLayout.closeHitSize,
                            height: ChatImagePreviewLayout.closeHitSize)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .modifier(ChatImageViewerGlass())
                .accessibilityLabel(String(localized: "Share"))
                .accessibilityIdentifier("chat-image-viewer-share")
            } else {
                // Holds the title centered while the first image decodes.
                Color.clear.frame(width: ChatImagePreviewLayout.closeHitSize, height: 1)
            }
        }
        .foregroundStyle(OpenClawChatTheme.assistantText)
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }
}

/// The chat header's interactive glass circle.
private struct ChatImageViewerGlass: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: .circle)
        } else {
            content.background(.regularMaterial, in: Circle())
        }
    }
}

/// Full-screen image viewer: grows out of the tapped thumbnail with the system zoom transition,
/// pages through the message's images, and drags back down into the thumbnail to close.
@MainActor
final class ChatImageViewerController: UIViewController,
    UIPageViewControllerDataSource, UIPageViewControllerDelegate
{
    typealias Load = @MainActor @Sendable (String) async throws -> OpenClawChatLoadedMedia?

    private let items: [ChatImageViewerItem]
    private let load: Load
    let chrome = ChatImageViewerChrome()
    let pager = UIPageViewController(
        transitionStyle: .scroll,
        navigationOrientation: .horizontal,
        options: [.interPageSpacing: 16])
    private var bar: UIHostingController<ChatImageViewerBar>?
    private var filmstrip: UIHostingController<ChatImageViewerFilmstrip>?
    /// Pixels the opener already holds (a draft's staged photos), keyed like the items.
    private let providedThumbnails: [String: UIImage]
    private var pages: [Int: ChatImageViewerPageController] = [:]
    private(set) var currentIndex: Int

    /// Opens the viewer on `artifactId`, growing out of its thumbnail.
    static func present(
        items: [ChatImageViewerItem],
        artifactId: String,
        thumbnail: UIImage,
        thumbnails: [String: UIImage] = [:],
        load: @escaping Load)
    {
        guard let index = items.firstIndex(where: { $0.artifactId == artifactId }),
              let source = ChatImageViewerSources.view(for: artifactId),
              // Transcript rows can live in detached hosting controllers; present from the window.
              var presenter = source.window?.rootViewController
        else { return }
        while let presented = presenter.presentedViewController, !presented.isBeingDismissed {
            presenter = presented
        }
        let viewer = ChatImageViewerController(
            items: items, index: index, thumbnail: thumbnail, thumbnails: thumbnails, load: load)
        // Over, not instead of, the transcript: a removed transcript rebuilds its rows and loses its
        // scroll position, and the image would have no thumbnail to return to.
        viewer.modalPresentationStyle = .overFullScreen
        // Over a transcript the viewer still owns the status bar, which hides with the bar.
        viewer.modalPresentationCapturesStatusBarAppearance = true
        // The system zoom transition already cross-fades under Reduce Motion, and keeps the drag.
        let options = UIViewController.Transition.ZoomOptions()
        options.interactiveDismissShouldBegin = { [weak viewer] context in
            context.willBegin && Self.allowsInteractiveDismiss(
                velocity: context.velocity,
                isZoomed: viewer?.currentPage?.isZoomed == true)
        }
        options.alignmentRectProvider = { [weak viewer] _ in
            viewer?.currentImageFrame
        }
        // The viewer's own canvas fades instead, so only the image travels.
        options.dimmingColor = .clear
        viewer.preferredTransition = .zoom(options: options) { context in
            guard let viewer = context.zoomedViewController as? ChatImageViewerController else { return nil }
            return ChatImageViewerSources.view(for: viewer.currentItem.artifactId)
        }
        presenter.present(viewer, animated: true)
    }

    init(
        items: [ChatImageViewerItem],
        index: Int,
        thumbnail: UIImage,
        thumbnails: [String: UIImage] = [:],
        load: @escaping Load)
    {
        self.items = items
        self.load = load
        self.currentIndex = index
        self.providedThumbnails = thumbnails
        super.init(nibName: nil, bundle: nil)
        self.pages[index] = ChatImageViewerPageController(
            item: items[index],
            position: ChatImageViewerItem.positionText(index: index, count: items.count),
            thumbnail: thumbnail,
            load: load,
            host: self)
        self.chrome.close = { [weak self] in self?.dismiss(animated: true) }
        self.chrome.selectStrip = { [weak self] index in self?.showPage(index) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    var currentItem: ChatImageViewerItem {
        self.items[self.currentIndex]
    }

    private var currentPage: ChatImageViewerPageController? {
        self.pages[self.currentIndex]
    }

    /// Only a downward drag on the fitted image closes the viewer: sideways drags page, and a
    /// zoomed image pans.
    nonisolated static func allowsInteractiveDismiss(velocity: CGVector, isZoomed: Bool) -> Bool {
        !isZoomed && velocity.dy > 0 && velocity.dy >= abs(velocity.dx)
    }

    /// Where the current image sits, so the zoom transition lines it up with its thumbnail.
    private var currentImageFrame: CGRect? {
        guard let page = self.currentPage, let frame = page.imageFrame(in: self.view) else { return nil }
        return frame
    }

    /// Bar bottom and the row of thumbnails (or the home indicator): a fitted image rests between
    /// them, so the row never covers it. The row's space stays reserved while the chrome hides, so
    /// the image does not move.
    var obstructedInsets: UIEdgeInsets {
        let bottom = if let strip = self.filmstrip?.view, strip.frame.height > 0 {
            self.view.bounds.maxY - strip.frame.minY
        } else {
            self.view.safeAreaInsets.bottom
        }
        return UIEdgeInsets(
            top: self.bar?.view.frame.maxY ?? self.view.safeAreaInsets.top,
            left: 0,
            bottom: bottom,
            right: 0)
    }

    override var prefersStatusBarHidden: Bool {
        self.chrome.isHidden
    }

    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation {
        .fade
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        self.view.backgroundColor = OpenClawChatTheme.canvasUIColor.withAlphaComponent(0)
        self.view.accessibilityViewIsModal = true

        self.addChild(self.pager)
        self.pager.view.frame = self.view.bounds
        self.pager.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        self.view.addSubview(self.pager.view)
        self.pager.didMove(toParent: self)
        self.pager.dataSource = self.items.count > 1 ? self : nil
        self.pager.delegate = self
        if let page = self.currentPage {
            self.pager.setViewControllers([page], direction: .forward, animated: false)
        }

        let bar = UIHostingController(rootView: ChatImageViewerBar(chrome: self.chrome))
        bar.sizingOptions = .intrinsicContentSize
        bar.view.backgroundColor = .clear
        self.addChild(bar)
        bar.view.translatesAutoresizingMaskIntoConstraints = false
        self.view.addSubview(bar.view)
        NSLayoutConstraint.activate([
            bar.view.topAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.topAnchor),
            bar.view.leadingAnchor.constraint(equalTo: self.view.leadingAnchor),
            bar.view.trailingAnchor.constraint(equalTo: self.view.trailingAnchor),
        ])
        bar.didMove(toParent: self)
        self.bar = bar

        if ChatImageViewerFilmstrip.isShown(count: self.items.count) {
            let strip = UIHostingController(rootView: ChatImageViewerFilmstrip(chrome: self.chrome))
            strip.sizingOptions = .intrinsicContentSize
            strip.view.backgroundColor = .clear
            self.addChild(strip)
            strip.view.translatesAutoresizingMaskIntoConstraints = false
            self.view.addSubview(strip.view)
            NSLayoutConstraint.activate([
                strip.view.bottomAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.bottomAnchor),
                strip.view.leadingAnchor.constraint(equalTo: self.view.leadingAnchor),
                strip.view.trailingAnchor.constraint(equalTo: self.view.trailingAnchor),
            ])
            strip.didMove(toParent: self)
            self.filmstrip = strip
        }
        self.updateChrome()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let insets = self.obstructedInsets
        for page in self.pages.values {
            page.obstructedInsets = insets
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The transcript fades into the canvas as the image grows out of its thumbnail.
        let canvas = OpenClawChatTheme.canvasUIColor
        if let coordinator = self.transitionCoordinator {
            coordinator.animate(alongsideTransition: { _ in self.view.backgroundColor = canvas })
        } else {
            self.view.backgroundColor = canvas
        }
        self.applyChromeVisibility(animatedWith: self.transitionCoordinator)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Also runs when a drag to close is let go early: bring the canvas and the bar back.
        self.view.backgroundColor = OpenClawChatTheme.canvasUIColor
        self.applyChromeVisibility(animatedWith: nil)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // The image alone travels back to its thumbnail: the bar and the canvas leave as the
        // drag starts, so the transcript shows around the image.
        let views: [UIView?] = [self.bar?.view, self.filmstrip?.view]
        UIView.animate(withDuration: 0.15) {
            views.forEach { $0?.alpha = 0 }
            self.view.backgroundColor = OpenClawChatTheme.canvasUIColor.withAlphaComponent(0)
        }
    }

    override func accessibilityPerformEscape() -> Bool {
        self.dismiss(animated: true)
        return true
    }

    // MARK: Chrome

    func pageDidTap(_ page: ChatImageViewerPageController) {
        guard page === self.currentPage else { return }
        self.chrome.isHidden.toggle()
        self.applyChromeVisibility(animatedWith: nil)
    }

    func page(_ page: ChatImageViewerPageController, didChangeZoomed zoomed: Bool) {
        guard page === self.currentPage else { return }
        guard self.chrome.isHidden != zoomed else { return }
        self.chrome.isHidden = zoomed
        self.applyChromeVisibility(animatedWith: nil)
    }

    func pageDidLoadImage(_ page: ChatImageViewerPageController) {
        if page === self.currentPage {
            self.updateChrome()
        } else {
            self.updateStrip()
        }
    }

    private func applyChromeVisibility(animatedWith coordinator: UIViewControllerTransitionCoordinator?) {
        let alpha: CGFloat = self.chrome.isHidden ? 0 : 1
        let bar = self.bar?.view
        let strip = self.filmstrip?.view
        if #available(iOS 26, *) {
            self.currentPage?.scrollView?.topEdgeEffect.isHidden = self.chrome.isHidden
            self.currentPage?.scrollView?.bottomEdgeEffect.isHidden = self.chrome.isHidden || strip == nil
        }
        for view in [bar, strip] {
            view?.isUserInteractionEnabled = !self.chrome.isHidden
            view?.accessibilityElementsHidden = self.chrome.isHidden
        }
        let apply = {
            bar?.alpha = alpha
            strip?.alpha = alpha
        }
        if let coordinator {
            coordinator.animate(alongsideTransition: { _ in apply() })
        } else if UIAccessibility.isReduceMotionEnabled {
            apply()
        } else {
            UIView.animate(withDuration: 0.2, animations: apply)
        }
        self.setNeedsStatusBarAppearanceUpdate()
    }

    private func updateChrome() {
        let item = self.currentItem
        self.chrome.title = item.title
        self.chrome.position = ChatImageViewerItem.positionText(index: self.currentIndex, count: self.items.count)
        self.chrome.shareImage = self.currentPage?.image
        self.chrome.shareName = item.title ?? item.label
        self.updateStrip()
        if #available(iOS 26, *), let scroll = self.currentPage?.scrollView {
            // The chrome stays in place while the pager swaps its image scroll view underneath.
            for (container, edge) in [(self.bar?.view, UIRectEdge.top), (self.filmstrip?.view, .bottom)] {
                guard let container else { continue }
                let interaction = container.interactions.compactMap { $0 as? UIScrollEdgeElementContainerInteraction }
                    .first ?? UIScrollEdgeElementContainerInteraction()
                interaction.edge = edge
                interaction.scrollView = scroll
                if interaction.view == nil { container.addInteraction(interaction) }
            }
            scroll.topEdgeEffect.style = .soft
            scroll.topEdgeEffect.isHidden = self.chrome.isHidden
            scroll.bottomEdgeEffect.style = .soft
            scroll.bottomEdgeEffect.isHidden = self.chrome.isHidden || self.filmstrip == nil
        }
        // VoiceOver moves to the new page's image, which reads its name and, for a message with
        // several images, its position as the value.
        if let page = self.currentPage, self.isViewLoaded {
            UIAccessibility.post(notification: .layoutChanged, argument: page.view)
        }
    }

    /// The row's thumbnails come from pixels already in hand, never a request of their own: a page's
    /// image, the opener's, or the transcript's memory and on-screen thumbnails.
    private func updateStrip() {
        guard ChatImageViewerFilmstrip.isShown(count: self.items.count) else { return }
        self.chrome.strip = self.items.indices.map { index in
            let id = self.items[index].artifactId
            return self.pages[index]?.image ?? self.providedThumbnails[id]
                ?? ChatMediaImageMemory.image(for: id) ?? ChatImageViewerSources.view(for: id)?.image
        }
        self.chrome.stripIndex = self.currentIndex
    }

    // MARK: Paging

    /// Moves to `index` from the row of thumbnails.
    func showPage(_ index: Int) {
        guard index != self.currentIndex, let page = self.page(at: index) else { return }
        let direction: UIPageViewController.NavigationDirection = index > self.currentIndex ? .forward : .reverse
        self.pager.setViewControllers([page], direction: direction, animated: !UIAccessibility.isReduceMotionEnabled)
        self.settle(on: index)
    }

    private func settle(on index: Int) {
        self.currentIndex = index
        // Pages farther than one swipe away are rebuilt on demand.
        self.pages = self.pages.filter { abs($0.key - index) <= 1 }
        self.pages[index]?.resetZoom()
        self.updateChrome()
    }

    private func page(at index: Int) -> ChatImageViewerPageController? {
        guard self.items.indices.contains(index) else { return nil }
        if let page = self.pages[index] { return page }
        let item = self.items[index]
        let page = ChatImageViewerPageController(
            item: item,
            position: ChatImageViewerItem.positionText(index: index, count: self.items.count),
            // The transcript's memory holds every image it decoded, on screen or not.
            thumbnail: ChatMediaImageMemory.image(for: item.artifactId)
                ?? ChatImageViewerSources.view(for: item.artifactId)?.image,
            load: self.load,
            host: self)
        page.obstructedInsets = self.obstructedInsets
        self.pages[index] = page
        return page
    }

    func pageViewController(
        _ pageViewController: UIPageViewController,
        viewControllerBefore viewController: UIViewController) -> UIViewController?
    {
        guard let page = viewController as? ChatImageViewerPageController,
              let index = self.index(of: page) else { return nil }
        return self.page(at: index - 1)
    }

    func pageViewController(
        _ pageViewController: UIPageViewController,
        viewControllerAfter viewController: UIViewController) -> UIViewController?
    {
        guard let page = viewController as? ChatImageViewerPageController,
              let index = self.index(of: page) else { return nil }
        return self.page(at: index + 1)
    }

    func pageViewController(
        _ pageViewController: UIPageViewController,
        didFinishAnimating finished: Bool,
        previousViewControllers: [UIViewController],
        transitionCompleted completed: Bool)
    {
        guard completed,
              let page = pageViewController.viewControllers?.first as? ChatImageViewerPageController,
              let index = self.index(of: page) else { return }
        self.settle(on: index)
    }

    private func index(of page: ChatImageViewerPageController) -> Int? {
        self.pages.first { $0.value === page }?.key
    }
}

/// One zoomable image. Shows the thumbnail at once and sharpens in place once the full image decodes.
@MainActor
final class ChatImageViewerPageController: UIViewController {
    private let item: ChatImageViewerItem
    /// "2 of 3" for a message with several images; the image's accessibility value.
    private let position: String?
    private let load: ChatImageViewerController.Load
    private weak var host: ChatImageViewerController?
    private(set) var image: UIImage?
    fileprivate(set) var scrollView: ChatZoomableImageScrollView?
    private var loadTask: Task<Void, Never>?

    var obstructedInsets: UIEdgeInsets = .zero {
        didSet { self.scrollView?.obstructedInsets = self.obstructedInsets }
    }

    init(
        item: ChatImageViewerItem,
        position: String?,
        thumbnail: UIImage?,
        load: @escaping ChatImageViewerController.Load,
        host: ChatImageViewerController)
    {
        self.item = item
        self.position = position
        self.load = load
        self.host = host
        self.image = thumbnail
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        self.loadTask?.cancel()
    }

    var isZoomed: Bool {
        self.scrollView?.isZoomed ?? false
    }

    func imageFrame(in view: UIView) -> CGRect? {
        guard let scrollView, scrollView.window != nil else { return nil }
        return scrollView.imageView.convert(scrollView.imageView.bounds, to: view)
    }

    func resetZoom() {
        guard let scrollView, scrollView.isZoomed else { return }
        scrollView.setZoomScale(scrollView.minimumZoomScale, animated: false)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        self.view.backgroundColor = .clear
        self.view.isAccessibilityElement = false
        if let image = self.image {
            self.installScrollView(image: image, pixelSize: self.layoutPixelSize(for: image))
        } else if let pixelSize = self.item.pixelSize {
            // Hold the final frame so the image fades in where it will stay.
            self.installScrollView(image: nil, pixelSize: ChatImageViewerItem.displayPixelSize(pixelSize))
        }
        self.loadFullImageIfNeeded()
    }

    private func layoutPixelSize(for image: UIImage) -> CGSize {
        if let pixelSize = self.item.pixelSize {
            return ChatImageViewerItem.displayPixelSize(pixelSize)
        }
        return CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
    }

    private func installScrollView(image: UIImage?, pixelSize: CGSize) {
        let scrollView = ChatZoomableImageScrollView(image: image, pixelSize: pixelSize)
        scrollView.frame = self.view.bounds
        scrollView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scrollView.obstructedInsets = self.obstructedInsets
        scrollView.imageView.isAccessibilityElement = true
        scrollView.imageView.accessibilityLabel = self.item.label
        scrollView.imageView.accessibilityTraits = .image
        // The bar's "2 of 3" hides with the bar; VoiceOver reads the position from the image.
        scrollView.imageView.accessibilityValue = self.position
        scrollView.onZoomedChange = { [weak self] zoomed in
            guard let self else { return }
            self.host?.page(self, didChangeZoomed: zoomed)
        }
        let tap = UITapGestureRecognizer(target: self, action: #selector(self.didTap))
        tap.require(toFail: scrollView.doubleTapRecognizer)
        scrollView.addGestureRecognizer(tap)
        self.view.addSubview(scrollView)
        self.scrollView = scrollView
    }

    @objc private func didTap() {
        self.host?.pageDidTap(self)
    }

    private func loadFullImageIfNeeded() {
        if let image = self.image,
           ChatImageViewerItem.thumbnailIsFullResolution(
               thumbnailPixelSize: CGSize(
                   width: image.size.width * image.scale,
                   height: image.size.height * image.scale),
               originalPixelSize: self.item.pixelSize)
        {
            return
        }
        let artifactId = self.item.artifactId
        let load = self.load
        self.loadTask = Task { [weak self] in
            let decoded: UIImage? = await {
                guard let loaded = try? await load(artifactId),
                      case let .data(media) = loaded,
                      media.mimeType.lowercased().hasPrefix("image/")
                else { return nil }
                return await Task.detached(priority: .userInitiated) {
                    ChatMediaImageDecoder.decode(media.data, maxPixelSize: ChatImageViewerItem.maximumPixelSize)
                }.value
            }()
            guard !Task.isCancelled, let self else { return }
            if let decoded {
                self.show(decoded)
            } else if self.image == nil {
                self.showUnavailable()
            }
        }
    }

    private func show(_ decoded: UIImage) {
        let hadImage = self.image != nil
        self.image = decoded
        if let scrollView {
            scrollView.setImage(decoded)
            if !hadImage, !UIAccessibility.isReduceMotionEnabled {
                scrollView.imageView.alpha = 0
                UIView.animate(withDuration: 0.2) { scrollView.imageView.alpha = 1 }
            }
        } else {
            self.installScrollView(
                image: decoded,
                pixelSize: CGSize(
                    width: decoded.size.width * decoded.scale,
                    height: decoded.size.height * decoded.scale))
        }
        self.host?.pageDidLoadImage(self)
    }

    private func showUnavailable() {
        let label = UILabel()
        label.text = String(localized: "Couldn’t load image.")
        label.font = OpenClawChatTypography.bodyUIFont
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .secondaryLabel
        label.numberOfLines = 0
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        self.view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: self.view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: self.view.readableContentGuide.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: self.view.readableContentGuide.trailingAnchor),
        ])
    }
}

#endif
