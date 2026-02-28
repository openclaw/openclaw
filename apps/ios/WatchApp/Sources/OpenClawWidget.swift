import SwiftUI
import WidgetKit

// MARK: - Timeline Entry

struct OpenClawWidgetEntry: TimelineEntry {
    let date: Date
    let title: String
    let body: String
    let risk: String?
    let hasActions: Bool
    let relevance: TimelineEntryRelevance?
}

// MARK: - Timeline Provider

struct OpenClawWidgetProvider: TimelineProvider {
    func placeholder(in _: Context) -> OpenClawWidgetEntry {
        OpenClawWidgetEntry(
            date: .now, title: "OpenClaw", body: "Waiting for messages",
            risk: nil, hasActions: false, relevance: nil)
    }

    func getSnapshot(in _: Context, completion: @escaping (OpenClawWidgetEntry) -> Void) {
        completion(readLatestEntry())
    }

    func getTimeline(in _: Context, completion: @escaping (Timeline<OpenClawWidgetEntry>) -> Void) {
        let entry = readLatestEntry()
        let refresh = Date().addingTimeInterval(15 * 60)
        completion(Timeline(entries: [entry], policy: .after(refresh)))
    }

    private func readLatestEntry() -> OpenClawWidgetEntry {
        guard let data = WatchAppGroup.defaults.data(forKey: WatchInboxStore.persistedStateKey),
            let state = try? JSONDecoder().decode(WidgetPersistedState.self, from: data)
        else {
            return OpenClawWidgetEntry(
                date: .now, title: "OpenClaw", body: "No messages yet",
                risk: nil, hasActions: false, relevance: TimelineEntryRelevance(score: 0))
        }

        let hasActions = !(state.actions ?? []).isEmpty
        let score: Float = switch state.risk?.lowercased() {
        case "high": 80
        case "medium" where hasActions: 60
        case _ where hasActions: 50
        default: 20
        }

        return OpenClawWidgetEntry(
            date: state.updatedAt,
            title: state.title,
            body: state.body,
            risk: state.risk,
            hasActions: hasActions,
            relevance: TimelineEntryRelevance(score: score))
    }
}

// MARK: - Lightweight Codable state (mirrors WatchInboxStore.PersistedState)

private struct WidgetPersistedState: Codable {
    var title: String
    var body: String
    var updatedAt: Date
    var risk: String?
    var actions: [WidgetAction]?

    struct WidgetAction: Codable {
        var id: String
    }
}

// MARK: - Adaptive Widget View

struct OpenClawWidgetView: View {
    let entry: OpenClawWidgetEntry

    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            circularContent
        case .accessoryInline:
            inlineContent
        case .accessoryCorner:
            cornerContent
        default:
            rectangularContent
        }
    }

    // MARK: - Rectangular (Smart Stack)

    private var riskColor: Color? {
        switch entry.risk?.lowercased() {
        case "high": .red
        case "medium": .orange
        default: nil
        }
    }

    private var rectangularContent: some View {
        VStack(alignment: .leading, spacing: WatchDesignTokens.spacingXS) {
            HStack(spacing: WatchDesignTokens.spacingXS) {
                Text(entry.title)
                    .font(WatchDesignTokens.fontTitle)
                    .lineLimit(1)
                if let color = riskColor {
                    Circle()
                        .fill(color)
                        .frame(width: 8, height: 8)
                }
            }
            Text(entry.body)
                .font(WatchDesignTokens.fontCaption)
                .lineLimit(2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(URL(string: "openclaw://watch/inbox")!)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    // MARK: - Circular

    private var circularIcon: String {
        entry.hasActions ? "bubble.left.and.exclamationmark.bubble.right.fill" : "bubble.left.fill"
    }

    private var circularTint: Color {
        switch entry.risk?.lowercased() {
        case "high": .red
        case "medium": .orange
        default: .accentColor
        }
    }

    private var circularContent: some View {
        ZStack {
            AccessoryWidgetBackground()
            Image(systemName: circularIcon)
                .font(.system(size: 18))
                .foregroundStyle(circularTint)
        }
        .widgetURL(URL(string: "openclaw://watch/inbox")!)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    // MARK: - Inline

    private var inlineContent: some View {
        let prefix = entry.risk?.lowercased() == "high" ? "⚠ " : ""
        return Text("\(prefix)\(entry.title)")
    }

    // MARK: - Corner

    private var cornerContent: some View {
        Image(systemName: entry.hasActions ? "bubble.left.and.exclamationmark.bubble.right.fill" : "bubble.left.fill")
            .font(.title3)
            .widgetLabel {
                Text(entry.title)
            }
            .widgetURL(URL(string: "openclaw://watch/inbox")!)
            .containerBackground(.fill.tertiary, for: .widget)
    }
}

// MARK: - Widget

struct OpenClawWidget: Widget {
    let kind = "ai.openclaw.watch.smart-stack"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OpenClawWidgetProvider()) { entry in
            OpenClawWidgetView(entry: entry)
        }
        .configurationDisplayName("OpenClaw")
        .description("Latest notification from your gateway")
        .supportedFamilies([
            .accessoryRectangular,
            .accessoryCircular,
            .accessoryInline,
            .accessoryCorner,
        ])
    }
}

// MARK: - Widget Bundle

struct OpenClawWidgetBundle: WidgetBundle {
    var body: some Widget {
        OpenClawWidget()
        QuickReplyControl()
        ConnectionStatusControl()
    }
}
