import AppKit
import SwiftUI

// MARK: - CapsuleToggle

/// Capsule-shaped toggle glyph that visually matches the macOS switch style.
/// Purely visual — actual toggle action is handled by the host view's mouseDown.
struct CapsuleToggle: View {
    let isOn: Bool

    private let trackWidth: CGFloat = 26
    private let trackHeight: CGFloat = 15
    private let knobInset: CGFloat = 2

    private var knobDiameter: CGFloat { self.trackHeight - self.knobInset * 2 }

    var body: some View {
        ZStack(alignment: self.isOn ? .trailing : .leading) {
            Capsule()
                .fill(self.isOn ? Color.accentColor : Color(nsColor: .separatorColor))
                .frame(width: self.trackWidth, height: self.trackHeight)

            Circle()
                .fill(Color.white)
                .shadow(color: .black.opacity(0.15), radius: 1, x: 0, y: 1)
                .frame(width: self.knobDiameter, height: self.knobDiameter)
                .padding(.horizontal, self.knobInset)
        }
        .animation(.easeInOut(duration: 0.15), value: self.isOn)
    }
}

// MARK: - QuickSettingsRow

/// A single Quick Settings row: leading icon, label text, trailing CapsuleToggle.
/// Injected as a custom NSMenuItem.view so it renders identically to the active header row.
struct QuickSettingsRow: View {
    let icon: String
    let label: String
    let isOn: Bool
    let width: CGFloat

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: self.icon)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(Color.primary)
                .frame(width: 16, height: 16, alignment: .center)

            Text(self.label)
                .font(.system(size: 13))
                .foregroundStyle(Color.primary)

            Spacer(minLength: 8)

            CapsuleToggle(isOn: self.isOn)
        }
        .padding(.vertical, 5)
        .padding(.leading, 12)
        .padding(.trailing, 12)
        .frame(width: max(1, self.width), alignment: .leading)
    }
}

// MARK: - MenuSubMenuRow

/// A Quick Settings row that opens a submenu (e.g. Exec Approvals).
/// Shows: leading icon, label text, trailing current-value text + chevron.
struct MenuSubMenuRow: View {
    let icon: String
    let label: String
    let currentValue: String
    let width: CGFloat

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: self.icon)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(Color.primary)
                .frame(width: 16, height: 16, alignment: .center)

            Text(self.label)
                .font(.system(size: 13))
                .foregroundStyle(Color.primary)

            Spacer(minLength: 8)

            Text(self.currentValue)
                .font(.system(size: 13))
                .foregroundStyle(Color.secondary)

            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color.secondary)
        }
        .padding(.vertical, 5)
        .padding(.leading, 12)
        .padding(.trailing, 12)
        .frame(width: max(1, self.width), alignment: .leading)
    }
}

// MARK: - MenuNativeItemRow

/// Row view used to wrap native SwiftUI menu buttons (Actions + App sections)
/// so they share the same visual template — icon, label, optional chevron.
struct MenuNativeItemRow: View {
    let image: NSImage
    let label: String
    let hasSubmenu: Bool
    let width: CGFloat

    var body: some View {
        HStack(spacing: 8) {
            Image(nsImage: self.image)
                .renderingMode(.template)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 16, height: 16, alignment: .center)
                .foregroundStyle(Color.primary)

            Text(self.label)
                .font(.system(size: 13))
                .foregroundStyle(Color.primary)

            Spacer(minLength: 8)

            if self.hasSubmenu {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color.secondary)
            }
        }
        .padding(.vertical, 5)
        .padding(.leading, 12)
        .padding(.trailing, 12)
        .frame(width: max(1, self.width), alignment: .leading)
    }
}

// MARK: - MenuPickerRow

/// A picker-list row used inside selection submenus (e.g. Exec Approvals).
/// Shows a leading checkmark when selected, label text, and no trailing chevron.
struct MenuPickerRow: View {
    let label: String
    let isSelected: Bool
    let width: CGFloat

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: self.isSelected ? "checkmark" : "")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.primary)
                .frame(width: 16, height: 16, alignment: .center)

            Text(self.label)
                .font(.system(size: 13))
                .foregroundStyle(Color.primary)

            Spacer(minLength: 8)
        }
        .padding(.vertical, 5)
        .padding(.leading, 12)
        .padding(.trailing, 12)
        .frame(width: max(1, self.width), alignment: .leading)
    }
}

// MARK: - MenuSectionLabelView

/// Section label matching iOS-style menu grouping headers.
/// Uses 11 pt semibold, secondary colour, consistent left padding with content rows.
/// `paddingLeading` defaults to 12 (matches injected rows); pass a larger value when the
/// section precedes native SwiftUI menu items whose icons are indented by the state column.
struct MenuSectionLabelView: View {
    let title: String
    let width: CGFloat
    var paddingLeading: CGFloat = 12

    var body: some View {
        Text(self.title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 6)
            .padding(.bottom, 2)
            .padding(.leading, self.paddingLeading)
            .padding(.trailing, 12)
            .frame(width: max(1, self.width), alignment: .leading)
    }
}
