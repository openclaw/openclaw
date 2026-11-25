import SwiftUI

struct SelectionStateIndicator: View {
    let selected: Bool

    var body: some View {
        if self.selected {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.accentColor)
        } else {
            Image(systemName: "arrow.right.circle")
                .foregroundStyle(.secondary)
        }
    }
}

extension View {
    func openClawSelectableRowChrome(selected: Bool, enabled: Bool = true) -> some View {
        self.modifier(OpenClawSelectableRowChrome(selected: selected, enabled: enabled))
    }
}

private struct OpenClawSelectableRowChrome: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovered = false
    let selected: Bool
    let enabled: Bool

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(self.background))
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(
                        self.selected ? Color.accentColor.opacity(0.45) : Color.clear,
                        lineWidth: 1))
            .onHover { self.hovered = $0 }
    }

    private var background: Color {
        if self.selected { return Color.accentColor.opacity(0.12) }
        if self.hovered, self.enabled, self.isEnabled { return Color.secondary.opacity(0.08) }
        return Color.clear
    }
}
