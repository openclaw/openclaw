import SwiftUI

/// The working claw keeps its own height; only its horizontal slot is shared with tool rows.
struct ChatTranscriptIconColumn: DynamicProperty {
    #if os(iOS)
    @ScaledMetric(relativeTo: .body) var width: CGFloat = 20
    let spacing: CGFloat = 8
    #else
    let width: CGFloat? = nil
    let spacing: CGFloat = 9
    #endif
}

#if os(iOS)

/// Align every transcript tool to the first line, even when the title needs two lines.
struct ChatToolRowLabel<Label: View>: View {
    let asset: String?
    var disclosure: Angle?
    @ViewBuilder let label: Label
    private var iconColumn = ChatTranscriptIconColumn()
    @ScaledMetric(relativeTo: .body) private var bodySize = OpenClawChatTypography.transcriptBodySize

    init(asset: String? = nil, disclosure: Angle? = nil, @ViewBuilder label: () -> Label) {
        self.asset = asset
        self.disclosure = disclosure
        self.label = label()
    }

    var body: some View {
        let halfCap = OpenClawChatTypography.bodyUIFont.withSize(self.bodySize).capHeight / 2
        HStack(alignment: .firstTextBaseline, spacing: self.iconColumn.spacing) {
            if let asset {
                Image(decorative: asset, bundle: .module)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: self.iconColumn.width, height: self.iconColumn.width)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + halfCap }
                    .accessibilityHidden(true)
            }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                self.label
                    .font(OpenClawChatTypography.transcriptBody)
                    .fixedSize(horizontal: false, vertical: true)
                if let disclosure {
                    Image(systemName: "chevron.right")
                        .font(.system(size: self.bodySize * 0.6, weight: .semibold))
                        .rotationEffect(disclosure)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + halfCap }
                        .accessibilityHidden(true)
                }
            }
        }
        .foregroundStyle(Color(uiColor: .secondaryLabel))
    }
}
#endif
