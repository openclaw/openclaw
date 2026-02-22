import AppKit
import SwiftUI

/// Apple Wi-Fi–style header row: power icon, title, and a toggle switch.
/// Injected as a custom NSHostingView so the toggle renders as a real switch
/// rather than an NSMenu checkmark.
///
/// Uses a custom-drawn capsule toggle instead of `Toggle(.switch)` because
/// the native `NSSwitch` has hit-test issues inside `NSMenuItem.view`.
struct MenuActiveHeaderView: View {
    @Bindable var state: AppState
    let width: CGFloat
    private var isActive: Bool { !self.state.isPaused }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "power")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(self.isActive ? Color.primary : Color.secondary)
                .frame(width: 16, height: 16, alignment: .center)

            Text("OpenClaw")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(self.isActive ? Color.primary : Color.secondary)

            Spacer(minLength: 8)

            CapsuleToggle(isOn: self.isActive)
        }
        .padding(.vertical, 5)
        .padding(.leading, 12)
        .padding(.trailing, 12)
        .frame(width: max(1, self.width), alignment: .leading)
    }
}

// MARK: - Clickable host view

/// `HighlightedMenuItemHostView` subclass that handles `mouseDown` so the
/// active-header toggle actually fires when the user clicks the row.
///
/// `NSMenuItem.target/action` is ignored for items with a custom `view`, so
/// we intercept the click here instead.
final class ClickableMenuItemHostView: HighlightedMenuItemHostView {
    var onClick: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        // Flash the highlight briefly, then fire the action.
        self.onClick?()
    }
}
