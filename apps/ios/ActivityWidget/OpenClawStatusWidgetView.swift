import SwiftUI
import WidgetKit

struct OpenClawStatusWidgetView: View {
    let presentation: OpenClawWidgetPresentation
    @Environment(\.widgetFamily) private var family

    var body: some View {
        OpenClawStatusWidgetContent(presentation: self.presentation, family: self.family)
    }
}

struct OpenClawStatusWidgetContent: View {
    let presentation: OpenClawWidgetPresentation
    let family: WidgetFamily
    @Environment(\.locale) private var locale
    @Environment(\.timeZone) private var timeZone

    var body: some View {
        Group {
            switch self.family {
            case .accessoryInline:
                ViewThatFits(in: .vertical) {
                    self.compactContext()
                    self.compactContext(small: true)
                }
            case .accessoryCircular:
                ZStack {
                    AccessoryWidgetBackground()
                    ViewThatFits(in: .vertical) {
                        self.circularContext(lineLimit: 2)
                        self.circularContext(lineLimit: 1)
                        self.circularContext(lineLimit: 1, small: true)
                    }
                }
            case .accessoryRectangular:
                ViewThatFits(in: .vertical) {
                    self.summary(labelLineLimit: 1, showTime: false)
                    self.compactContext()
                    self.compactContext(small: true)
                }
            case .systemSmall, .systemMedium, .systemLarge, .systemExtraLarge:
                ViewThatFits(in: .vertical) {
                    self.summary(labelLineLimit: 3, showTime: true)
                    self.summary(labelLineLimit: 2, showTime: false)
                    self.compactContext()
                    self.compactContext(small: true)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            @unknown default:
                self.compactContext(small: true)
            }
        }
        .privacySensitive()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: self.presentation.accessibilityLabel(
            locale: self.locale,
            timeZone: self.timeZone)))
    }

    private func summary(labelLineLimit: Int, showTime: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let kind = self.presentation.kind {
                Text(verbatim: kind.text)
                    .font(OpenClawActivityType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let title = self.presentation.title {
                Text(verbatim: title)
                    .font(OpenClawActivityType.subheadSemiBold)
                    .lineLimit(labelLineLimit)
                    .minimumScaleFactor(0.8)
            }
            HStack(spacing: 4) {
                self.statusSymbol
                Text(verbatim: self.presentation.statusText)
                    .font(OpenClawActivityType.caption)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }
            if showTime, let time = self.presentation.recordedTimeText(locale: self.locale, timeZone: self.timeZone) {
                Text(verbatim: time)
                    .font(OpenClawActivityType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }
        }
    }

    private func circularContext(lineLimit: Int, small: Bool = false) -> some View {
        VStack(spacing: 3) {
            Text(verbatim: self.presentation.title ?? self.presentation.statusText)
                .font(small ? OpenClawActivityType.eyebrow : OpenClawActivityType.caption)
                .lineLimit(lineLimit)
                .minimumScaleFactor(0.8)
            self.statusIndicators
        }
    }

    private func compactContext(small: Bool = false) -> some View {
        HStack(alignment: .center, spacing: 4) {
            // Keep the selected name when space is scarce; qualifiers retain their own fixed slots.
            Text(verbatim: self.presentation.title ?? self.presentation.statusText)
                .font(small ? OpenClawActivityType.eyebrow : OpenClawActivityType.caption)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity, alignment: .leading)
            self.statusIndicators
        }
    }

    private var statusSymbol: some View {
        Image(systemName: self.symbol)
            .font(OpenClawActivityType.symbol(size: 12, weight: .semibold))
            .foregroundStyle(.primary)
            .frame(width: 14, height: 14)
    }

    private var statusIndicators: some View {
        HStack(spacing: 3) {
            self.statusSymbol
            // Separate fixed slots keep offline and fact age independently visible.
            HStack(spacing: 4) {
                Image(systemName: "wifi.slash")
                    .opacity(self.presentation.isOffline ? 1 : 0)
                    .frame(width: 12, height: 12)
                Group {
                    switch (self.presentation.freshness, self.presentation.state) {
                    case (.stale, _):
                        Image(systemName: "clock")
                    case (.unknown, .queued), (.unknown, .running), (.unknown, .terminal):
                        Image(systemName: "questionmark")
                    default:
                        Color.clear
                    }
                }
                .frame(width: 12, height: 12)
            }
            .font(OpenClawActivityType.symbol(size: 9, weight: .bold))
            .foregroundStyle(.secondary)
        }
        .fixedSize()
    }

    private var symbol: String {
        switch self.presentation.state {
        case .unknown: "questionmark.circle"
        case .queued: "clock"
        case .running: "arrow.triangle.2.circlepath"
        case .terminal(.completed): "checkmark.circle"
        case .terminal(.failed): "exclamationmark.circle"
        case .terminal(.cancelled): "xmark.circle"
        case .terminal(.timedOut), .expired: "clock.badge.exclamationmark"
        case .unconfigured: "plus.circle"
        case .unavailable: "slash.circle"
        case .permissionRequired, .locked: "lock"
        case .hidden: "eye.slash"
        }
    }
}
