import AppKit
import SwiftUI

class HighlightedMenuItemHostView: NSView {
    private var baseView: AnyView
    private let hosting: NSHostingView<AnyView>
    private var targetWidth: CGFloat
    private var tracking: NSTrackingArea?
    var showsHighlight: Bool = true
    private var hovered = false {
        didSet { self.updateHighlight() }
    }

    init(rootView: AnyView, width: CGFloat) {
        self.baseView = rootView
        self.hosting = NSHostingView(rootView: AnyView(rootView.environment(\.menuItemHighlighted, false)))
        self.targetWidth = max(1, width)
        super.init(frame: .zero)

        self.addSubview(self.hosting)
        self.hosting.autoresizingMask = [.width, .height]
        self.updateSizing()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: NSSize {
        let size = self.hosting.fittingSize
        return NSSize(width: self.targetWidth, height: size.height)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking {
            self.removeTrackingArea(tracking)
        }
        let options: NSTrackingArea.Options = [
            .mouseEnteredAndExited,
            .activeAlways,
            .inVisibleRect,
        ]
        let area = NSTrackingArea(rect: self.bounds, options: options, owner: self, userInfo: nil)
        self.addTrackingArea(area)
        self.tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        _ = event
        guard self.showsHighlight else { return }
        self.hovered = true
    }

    override func mouseExited(with event: NSEvent) {
        _ = event
        guard self.showsHighlight else { return }
        self.hovered = false
    }

    override func layout() {
        super.layout()
        self.hosting.frame = self.bounds
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard self.window != nil, self.showsHighlight else { return }
        let isHighlighted = self.enclosingMenuItem?.isHighlighted == true
        if isHighlighted != self.hovered {
            self.hovered = isHighlighted
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        if self.showsHighlight {
            let isHighlighted = self.enclosingMenuItem?.isHighlighted == true
            if isHighlighted {
                let path = NSBezierPath(
                    roundedRect: self.bounds.insetBy(dx: 4, dy: 1),
                    xRadius: 6, yRadius: 6)
                NSColor.unemphasizedSelectedContentBackgroundColor.setFill()
                path.fill()
            }
        }
        super.draw(dirtyRect)
    }

    func update(rootView: AnyView, width: CGFloat) {
        self.baseView = rootView
        self.targetWidth = max(1, width)
        self.updateHighlight()
    }

    private func updateHighlight() {
        self.hosting.rootView = AnyView(self.baseView.environment(\.menuItemHighlighted, self.hovered))
        self.updateSizing()
        self.needsDisplay = true
    }

    private func updateSizing() {
        let width = max(1, self.targetWidth)
        self.hosting.frame.size.width = width
        let size = self.hosting.fittingSize
        self.frame = NSRect(origin: .zero, size: NSSize(width: width, height: size.height))
        self.invalidateIntrinsicContentSize()
    }
}

struct MenuHostedHighlightedItem: NSViewRepresentable {
    let width: CGFloat
    let rootView: AnyView

    func makeNSView(context _: Context) -> HighlightedMenuItemHostView {
        HighlightedMenuItemHostView(rootView: self.rootView, width: self.width)
    }

    func updateNSView(_ nsView: HighlightedMenuItemHostView, context _: Context) {
        nsView.update(rootView: self.rootView, width: self.width)
    }
}
