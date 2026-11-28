import Charts
import SwiftUI

struct NativeUsageAnalytics: View {
    let report: NativeUsageReport
    let showsAgents: Bool
    let selectAgent: (String) -> Void
    @State private var metric: Metric = .tokens
    @State private var selectedDate: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Environment(\.dynamicTypeSize) private var typeSize

    private enum Metric { case tokens, cost }
    private struct Point: Identifiable {
        let date: Date
        let day: NativeUsageReport.Day
        var id: Date {
            self.date
        }
    }

    private static let calendarDate: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var body: some View {
        if let reason = self.report.partial?.message {
            Text(verbatim: reason).font(OpenClawType.footnote).foregroundStyle(.secondary)
        } else if let status = self.report.cacheStatus?.status, status != "fresh" {
            Text(status == "refreshing" ? "Updating usage. Totals may change." : "Usage data may be incomplete.")
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
        }
        let count = self.report.overview?.selectedSessionCount ?? self.report.aggregates.sessionCount
        if self.report.awaitingUsage {
            Text("Usage totals aren’t available yet.").font(OpenClawType.body)
        } else if count == 0, self.report.sessions.isEmpty, self.report.totals.totalTokens == 0, self.report.isComplete
        {
            Text("No usage in this date range.").font(OpenClawType.body)
        } else {
            Section {
                self.trend
            }
            self.agents
            Section {
                if let count { self.row("Sessions", count.formatted()) }
                self.row("User messages", self.report.aggregates.messages.user.formatted())
                self.row("Assistant messages", self.report.aggregates.messages.assistant.formatted())
                self.row("Tool calls", self.report.aggregates.messages.toolCalls.formatted())
                self.row("Errors", self.report.aggregates.messages.errors.formatted())
                DisclosureGroup {
                    if let results = self.report.aggregates.messages.toolResults { self.row(
                        "Tool results",
                        results.formatted()) }
                    if let messages = self.report.aggregates.messages.total, messages > 0 {
                        let tokens = Double(self.report.totals.totalTokens) / Double(messages)
                        self.row("Tokens per message", tokens.formatted(.number.precision(.fractionLength(0))))
                        self.row(
                            "Error rate",
                            (Double(self.report.aggregates.messages.errors) / Double(messages))
                                .formatted(.percent.precision(.fractionLength(2))))
                    }
                    if let duration = self.report.overview?.durationMs,
                       let sessions = self.report.overview?.durationCount,
                       sessions > 0
                    {
                        self.row(
                            "Average session duration",
                            Duration.seconds(duration / Double(sessions) / 1000).formatted(.units(allowed: [
                                .hours,
                                .minutes,
                                .seconds,
                            ])))
                    }
                    if let latency = self.report.aggregates.latency {
                        if let ms = latency.timedMs, ms > 0, let tokens = latency.timedTokens {
                            self.row(
                                "Tokens per minute",
                                (tokens / ms * 60000).formatted(.number.precision(.fractionLength(0))))
                        }
                        self.row(
                            "Average latency",
                            Duration.seconds(latency.avgMs / 1000).formatted(.units(allowed: [
                                .seconds,
                                .milliseconds,
                            ])))
                        self.row(
                            "95th percentile latency",
                            Duration.seconds(latency.p95Ms / 1000).formatted(.units(allowed: [
                                .seconds,
                                .milliseconds,
                            ])))
                    }
                } label: { Text("More activity metrics").font(OpenClawType.subhead) }
            } header: { Text("Activity").font(OpenClawType.subheadSemiBold) }
            Section {
                self.row("Input", self.report.totals.input.formatted())
                self.row("Output", self.report.totals.output.formatted())
                self.row("Cache read", self.report.totals.cacheRead.formatted())
                self.row("Cache write", self.report.totals.cacheWrite.formatted())
                let totals = self.report.totals
                let measured = totals.input - (totals.cacheUnmeasuredInput ?? 0) + totals.cacheRead + totals.cacheWrite
                if measured > 0 {
                    self.row(
                        "Cache hit rate",
                        (Double(totals.cacheRead) / Double(measured)).formatted(.percent.precision(.fractionLength(1))))
                }
                if let cost = self.report.totals.recordedCost {
                    self.row(
                        (self.report.totals.missingCostEntries ?? 0) > 0 ? "Known cost" : "Recorded cost",
                        Self.dollars(cost))
                }
                if (self.report.totals.missingCostEntries ?? 0) > 0 {
                    Text("Some usage has no cost data.").font(OpenClawType.footnote).foregroundStyle(.secondary)
                }
            } header: { Text(self.report.totals.recordedCost != nil || (self.report.totals.missingCostEntries ?? 0) > 0
                    ? "Tokens and cost" : "Token breakdown").font(OpenClawType.subheadSemiBold) }
            self.breakdowns
        }
    }

    private var trend: some View {
        let points = (self.report.aggregates.costDaily ?? []).compactMap { day in
            Self.calendarDate.date(from: day.date).map { Point(date: $0, day: day) }
        }.sorted { $0.date < $1.date }
        let isCost = self.metric == .cost && self.report.totals.recordedCost != nil
        let selected = self.selectedDate.flatMap { selection in points.first { Calendar.current.isDate(
            $0.date,
            inSameDayAs: selection) } }
        let tokens = (selected?.day.totalTokens ?? self.report.totals.totalTokens).formatted()
        let cost = (selected == nil ? self.report.totals.recordedCost : selected?.day.recordedCost).map(Self.dollars)
        let metricLayout = self.typeSize
            .isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading)) : AnyLayout(HStackLayout(
                alignment: .top,
                spacing: 14))
        return VStack(alignment: .leading, spacing: 12) {
            metricLayout {
                self.metricButton(.tokens, title: "Tokens", value: tokens, selected: !isCost)
                    .accessibilityIdentifier("Usage.Headline")
                if self.report.totals.recordedCost != nil {
                    self.metricButton(
                        .cost,
                        title: (self.report.totals.missingCostEntries ?? 0) > 0 ? "Known cost" : "Recorded cost",
                        value: cost ?? String(localized: "Unpriced"),
                        selected: isCost)
                }
            }
            if let selected {
                Text(verbatim: selected.date.formatted(date: .long, time: .omitted)).font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            }
            if !points.isEmpty, let start = Self.calendarDate.date(from: self.report.startDate),
               let last = Self.calendarDate.date(from: self.report.endDate), let end = Calendar.current.date(
                   byAdding: .day,
                   value: 1,
                   to: last), start < end
            {
                Chart {
                    ForEach(points) { point in
                        if let y = isCost ? point.day.recordedCost : Double(point.day.totalTokens) {
                            if points.count > 60 {
                                if isCost {
                                    PointMark(x: .value("Day", point.date), y: .value("Cost", y))
                                        .symbolSize(6).foregroundStyle(OpenClawBrand.accent)
                                        .accessibilityValue(Self.dollars(y))
                                } else {
                                    LineMark(x: .value("Day", point.date), y: .value("Tokens", y))
                                        .foregroundStyle(OpenClawBrand.accent)
                                }
                            } else {
                                BarMark(
                                    x: .value("Day", point.date, unit: .day),
                                    y: .value(isCost ? "Cost" : "Tokens", y))
                                    .cornerRadius(2)
                                    .foregroundStyle(OpenClawBrand.accent
                                        .opacity(selected == nil || selected?.id == point.id ? 1 : 0.38))
                                    .accessibilityLabel(point.date.formatted(date: .long, time: .omitted))
                                    .accessibilityValue(isCost ? Self.dollars(y) : point.day.totalTokens.formatted())
                            }
                        }
                    }
                }
                .chartXScale(domain: start...end)
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 3)) {
                        AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) {
                        AxisGridLine()
                        if isCost {
                            AxisValueLabel(format: FloatingPointFormatStyle<Double>.Currency(code: "USD")
                                .precision(.fractionLength(0...2)))
                        } else {
                            AxisValueLabel(format: FloatingPointFormatStyle<Double>.number.notation(.compactName))
                        }
                    }
                }
                .chartXSelection(value: self.$selectedDate)
                .frame(height: 152)
                Text("Select a day to see its totals.").font(OpenClawType.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
        .animation(self.reduceMotion ? nil : .easeOut(duration: 0.22), value: tokens)
    }

    private func metricButton(_ metric: Metric, title: LocalizedStringKey, value: String, selected: Bool) -> some View {
        Button { self.metric = metric } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(OpenClawType.footnoteMedium).foregroundStyle(.secondary)
                Text(verbatim: value).font(OpenClawType.title3).monospacedDigit().contentTransition(.numericText())
            }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
                .background(
                    selected ? OpenClawBrand.accent.opacity(0.09) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder private var agents: some View {
        if self.showsAgents, !self.report.aggregates.byAgent.isEmpty {
            Section {
                ForEach(Array(self.report.aggregates.byAgent.enumerated()), id: \.offset) { _, group in
                    if let name = group.agentId {
                        Button { self.selectAgent(name) } label: {
                            HStack(alignment: .center, spacing: 12) {
                                VStack(alignment: .leading, spacing: 4) {
                                    self.ranking(name, tokens: group.totals.totalTokens)
                                    let share = Double(group.totals.totalTokens) / Double(max(
                                        1,
                                        self.report.totals.totalTokens))
                                    Text(verbatim: [
                                        share.formatted(.percent.precision(.fractionLength(0))),
                                        group.totals.recordedCost.map(Self.dollars),
                                    ].compactMap(\.self).joined(separator: " · "))
                                        .font(OpenClawType.caption).foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: "chevron.right")
                                    .imageScale(.small).foregroundStyle(.secondary)
                                    .frame(width: 18).accessibilityHidden(true)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("Usage.Agent." + name)
                    }
                }
            } header: { Text("Agents").font(OpenClawType.subheadSemiBold) }
        }
    }

    @ViewBuilder private var breakdowns: some View {
        self
            .groups("Models", self.report.aggregates.byModel) {
                [$0.provider, $0.model].compactMap(\.self).joined(separator: " / ")
            }
        self.groups("Providers", self.report.aggregates.byProvider) { $0.provider ?? "" }
        self.groups("Channels", self.report.aggregates.byChannel) { $0.channel ?? "" }
        if !self.report.aggregates.tools.tools.isEmpty {
            Section {
                ForEach(Array(self.report.aggregates.tools.tools.enumerated()), id: \.offset) { _, entry in
                    LabeledContent { Text(verbatim: entry.count.formatted()).font(OpenClawType.subheadMedium) }
                        label: { Text(verbatim: entry.name).font(OpenClawType.subhead) }
                }
            } header: { Text("Tools").font(OpenClawType.subheadSemiBold) }
        }
        if !self.report.sessions.isEmpty {
            Section {
                ForEach(self.report.sessions) { session in
                    LabeledContent {
                        Text(verbatim: session.usage?.totalTokens.formatted() ?? "—").font(OpenClawType.subheadMedium)
                    } label: { Text(verbatim: session.label ?? session.key).font(OpenClawType.subhead) }
                }
            } header: { Text("Sessions by token usage").font(OpenClawType.subheadSemiBold) }
                footer: {
                    if let total = self.report.overview?.total, total > self.report.sessions.count {
                        Text(String(
                            format: String(localized: "Showing %@ of %@ sessions."),
                            self.report.sessions.count.formatted(),
                            total.formatted()))
                            .font(OpenClawType.caption)
                    }
                }
        }
    }

    @ViewBuilder private func groups(
        _ title: LocalizedStringKey,
        _ items: [NativeUsageReport.Attribution],
        name: @escaping (NativeUsageReport.Attribution) -> String) -> some View
    {
        if !items.isEmpty {
            Section {
                ForEach(Array(items.enumerated()), id: \.offset) { _, group in
                    let label = name(group)
                    self.ranking(label.isEmpty ? String(localized: "Unknown") : label, tokens: group.totals.totalTokens)
                }
            } header: { Text(title).font(OpenClawType.subheadSemiBold) }
        }
    }

    private func ranking(_ name: String, tokens: Int) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            LabeledContent { Text(verbatim: tokens.formatted()).font(OpenClawType.subheadMedium) }
                label: { Text(verbatim: name).font(OpenClawType.subhead) }
            if self.report.totals.totalTokens > 0 {
                ProgressView(value: min(1, Double(tokens) / Double(self.report.totals.totalTokens)))
                    .accessibilityHidden(true)
            }
        }
    }

    private func row(_ title: LocalizedStringKey, _ value: String) -> some View {
        LabeledContent { Text(verbatim: value).font(OpenClawType.subheadMedium) }
            label: { Text(title).font(OpenClawType.subhead) }
    }

    private static func dollars(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(value > 0 && value < 0.01 ? 4 : 2)))
    }
}
