import SwiftUI

private struct ViewWidthPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

extension View {
    func onWidthChange(_ onChange: @escaping (CGFloat) -> Void) -> some View {
        self.background(
            GeometryReader { proxy in
                Color.clear.preference(key: ViewWidthPreferenceKey.self, value: proxy.size.width)
            })
            .onPreferenceChange(ViewWidthPreferenceKey.self, perform: onChange)
    }
}

