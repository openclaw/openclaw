import AppKit

@MainActor
enum WindowPlacement {
    static func centeredFrame(size: NSSize, on screen: NSScreen? = NSScreen.main) -> NSRect {
        let bounds = (screen?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? .zero)
        if bounds == .zero {
            return NSRect(origin: .zero, size: size)
        }

        let clampedWidth = min(size.width, bounds.width)
        let clampedHeight = min(size.height, bounds.height)

        let x = round(bounds.minX + (bounds.width - clampedWidth) / 2)
        let y = round(bounds.minY + (bounds.height - clampedHeight) / 2)
        return NSRect(x: x, y: y, width: clampedWidth, height: clampedHeight)
    }

    static func topRightFrame(
        size: NSSize,
        padding: CGFloat,
        on screen: NSScreen? = NSScreen.main) -> NSRect
    {
        let bounds = (screen?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? .zero)
        if bounds == .zero {
            return NSRect(origin: .zero, size: size)
        }

        let clampedWidth = min(size.width, bounds.width)
        let clampedHeight = min(size.height, bounds.height)

        let x = round(bounds.maxX - clampedWidth - padding)
        let y = round(bounds.maxY - clampedHeight - padding)
        return NSRect(x: x, y: y, width: clampedWidth, height: clampedHeight)
    }

    static func ensureOnScreen(
        window: NSWindow,
        defaultSize: NSSize,
        fallback: ((NSScreen?) -> NSRect)? = nil)
    {
        let frame = window.frame
        let targetScreens = NSScreen.screens.isEmpty ? [NSScreen.main].compactMap { $0 } : NSScreen.screens
        let isVisibleSomewhere = targetScreens.contains { screen in
            frame.intersects(screen.visibleFrame.insetBy(dx: 12, dy: 12))
        }

        if isVisibleSomewhere { return }

        let screen = NSScreen.main ?? targetScreens.first
        let next = fallback?(screen) ?? centeredFrame(size: defaultSize, on: screen)
        window.setFrame(next, display: false)
    }
}
