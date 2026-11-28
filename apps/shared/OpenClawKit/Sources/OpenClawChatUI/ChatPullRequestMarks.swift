#if os(iOS)
import SwiftUI
import UIKit

/// The Control UI's --ok, --danger, --warn and --pr-merged in light and dark appearances.
enum ChatPRInk {
    static let green = adaptive(light: 0x166534, dark: 0x22C55E)
    static let red = adaptive(light: 0xB91C1C, dark: 0xF87171)
    static let amber = adaptive(light: 0x92400E, dark: 0xF59E0B)
    static let purple = adaptive(light: 0x7C3AED, dark: 0xA78BFA)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let rgb = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat(rgb >> 16) / 255,
                green: CGFloat((rgb >> 8) & 255) / 255,
                blue: CGFloat(rgb & 255) / 255,
                alpha: 1)
        })
    }
}

extension ChatPullRequestState {
    var ink: Color {
        switch self {
        case .open: ChatPRInk.green
        case .draft: .secondary
        case .merged: ChatPRInk.purple
        case .closed: ChatPRInk.red
        }
    }
}

struct ChatPRStateGlyph: View {
    let state: ChatPullRequestState
    let size: CGFloat

    var body: some View {
        Image("PROcticon\(self.state.rawValue.capitalized)")
            .resizable().renderingMode(.template)
            .foregroundStyle(self.state.ink)
            .frame(width: self.size, height: self.size)
            .accessibilityHidden(true)
    }
}

struct ChatPRCheckMark: View {
    let kind: ChatActivityCheckRow.Kind
    var inPill = false

    var body: some View {
        Group {
            switch self.kind {
            case .passed:
                Image(systemName: "checkmark").resizable().scaledToFit().frame(width: 10, height: 10)
                    .foregroundStyle(ChatPRInk.green)
            case .failed where self.inPill:
                Image(systemName: "xmark").font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ChatPRInk.red)
            case .failed:
                Image(systemName: "xmark").resizable().scaledToFit().frame(width: 9, height: 9)
                    .foregroundStyle(ChatPRInk.red)
            case .running:
                Circle().fill(ChatPRInk.amber).frame(width: 7, height: 7)
            case .skipped:
                Color.clear
            }
        }
        .frame(width: 12, height: 12)
        .accessibilityHidden(true)
    }
}

struct ChatPullRequestPillFace: View {
    let pill: ChatActivityPill
    @ScaledMetric(relativeTo: .subheadline) private var labelSize: CGFloat = 15

    var body: some View {
        HStack(spacing: 6) {
            if let state = self.pill.pullRequestState {
                ChatPRStateGlyph(state: state, size: 16)
            } else {
                Image(systemName: "lock").font(.footnote).foregroundStyle(.secondary)
                    .frame(width: 16, height: 16).accessibilityHidden(true)
            }
            let font = UIFont(name: "Inter-Regular", size: self.labelSize) ?? .systemFont(ofSize: self.labelSize)
            ChatPRCapCenteredText(capHeight: font.capHeight) {
                Text(verbatim: self.pill.label)
                    .font(OpenClawChatTypography.body(size: 15, weight: .medium, relativeTo: .subheadline))
                    .monospacedDigit().foregroundStyle(.primary).fixedSize()
            }
            if let mark = self.pill.checkMark { ChatPRCheckMark(kind: mark, inPill: true) }
        }
    }
}

/// Move the number's measured first baseline (not the center of its line box) to half a capital
/// below the capsule axis. The neighboring square slots already center on that axis.
private struct ChatPRCapCenteredText: Layout {
    let capHeight: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews[0].sizeThatFits(.unspecified)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let baseline = subviews[0].dimensions(in: .unspecified)[VerticalAlignment.firstTextBaseline]
        subviews[0].place(
            at: CGPoint(x: bounds.minX, y: bounds.midY - baseline + self.capHeight / 2),
            anchor: .topLeading,
            proposal: .unspecified)
    }
}
#endif
