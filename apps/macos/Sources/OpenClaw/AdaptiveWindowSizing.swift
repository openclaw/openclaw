import AppKit

enum AdaptiveWindowSizing {
    static func clampedSize(
        ideal: NSSize,
        minimum: NSSize = .zero,
        padding: CGFloat = 32,
        within bounds: NSRect) -> NSSize
    {
        guard bounds != .zero else { return ideal }

        let availableWidth = max(0, bounds.width - (padding * 2))
        let availableHeight = max(0, bounds.height - (padding * 2))
        let desiredWidth = max(ideal.width, minimum.width)
        let desiredHeight = max(ideal.height, minimum.height)

        return NSSize(
            width: round(min(desiredWidth, availableWidth)),
            height: round(min(desiredHeight, availableHeight)))
    }

    @MainActor
    static func clampedSize(
        ideal: NSSize,
        minimum: NSSize = .zero,
        padding: CGFloat = 32,
        on screen: NSScreen? = NSScreen.main) -> NSSize
    {
        let bounds = screen?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? .zero
        return self.clampedSize(ideal: ideal, minimum: minimum, padding: padding, within: bounds)
    }
}
