#if os(iOS)
import SwiftUI

/// Fixed viewBox, scaled with the label rather than the card. Template ink is inherited from
/// the caller, including the neutral failure treatment and the user's appearance preference.
struct ChatVectorGlyph: View {
    let asset: String
    @ScaledMetric private var side: CGFloat

    init(asset: String, size: CGFloat, relativeTo: Font.TextStyle = .footnote) {
        self.asset = asset
        self._side = ScaledMetric(wrappedValue: size, relativeTo: relativeTo)
    }

    var body: some View {
        Image(decorative: self.asset, bundle: .module)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: self.side, height: self.side)
            .alignmentGuide(.firstTextBaseline) { $0[.bottom] - $0.height * 0.09 }
            .accessibilityHidden(true)
    }
}
#endif
