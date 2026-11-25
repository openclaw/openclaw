import Foundation

/// Snapshot of how full the active session's context window is, derived from
/// the newest usage-bearing message plus session/model metadata.
public struct OpenClawChatContextUsage: Equatable, Sendable {
    public let usedTokens: Int
    public let contextWindowTokens: Int?
    public let totalCost: Double?

    public var fractionUsed: Double? {
        guard let contextWindowTokens, contextWindowTokens > 0 else { return nil }
        return min(1, max(0, Double(self.usedTokens) / Double(contextWindowTokens)))
    }

    public var percentUsed: Int? {
        self.fractionUsed.map { Int(($0 * 100).rounded()) }
    }
}

enum ChatContextUsageCalculator {
    /// Prefers the newest per-run usage (fresh after every reply) and falls
    /// back to fresh server-side session totals when no message carries usage.
    static func usage(
        messages: [OpenClawChatMessage],
        sessionEntry: OpenClawChatSessionEntry?,
        defaults: OpenClawChatSessionsDefaults?,
        modelContextWindow: Int?) -> OpenClawChatContextUsage?
    {
        let sessionTokens = sessionEntry?.totalTokensFresh == false ? nil : sessionEntry?.totalTokens
        let usedTokens = self.latestRunTokens(in: messages) ?? sessionTokens
        guard let usedTokens, usedTokens > 0 else { return nil }
        let contextWindow = self.positive(sessionEntry?.contextTokens)
            ?? self.positive(defaults?.contextTokens)
            ?? self.positive(modelContextWindow)
        return OpenClawChatContextUsage(
            usedTokens: usedTokens,
            contextWindowTokens: contextWindow,
            totalCost: self.totalCost(in: messages))
    }

    /// Context pressure comes from the latest run: its usage already counts
    /// the whole conversation the model saw, so runs are not summed.
    private static func latestRunTokens(in messages: [OpenClawChatMessage]) -> Int? {
        for message in messages.reversed() {
            guard let usage = message.usage else { continue }
            // Counters can cover a whole multi-call turn; the marker is the latest call alone.
            if let total = usage.contextUsage?.totalTokens, total > 0 {
                return total
            }
            if let total = usage.total, total > 0 {
                return total
            }
            let summed = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output]
                .compactMap(\.self)
                .reduce(0, +)
            if summed > 0 {
                return summed
            }
        }
        return nil
    }

    private static func totalCost(in messages: [OpenClawChatMessage]) -> Double? {
        let costs = messages.compactMap { $0.usage?.cost?.total }
        guard !costs.isEmpty else { return nil }
        return costs.reduce(0, +)
    }

    fileprivate static func positive(_ value: Int?) -> Int? {
        guard let value, value > 0 else { return nil }
        return value
    }
}

extension OpenClawChatViewModel {
    public var contextUsage: OpenClawChatContextUsage? {
        let entry = self.currentSessionEntry()
        return ChatContextUsageCalculator.usage(
            messages: self.messages,
            sessionEntry: entry,
            defaults: self.sessionDefaults,
            modelContextWindow: self.selectedModelContextWindow(sessionEntry: entry))
    }

    private func selectedModelContextWindow(sessionEntry: OpenClawChatSessionEntry?) -> Int? {
        let selection = self.modelSelectionID != Self.defaultModelSelectionID
            ? self.modelSelectionID
            : (sessionEntry?.model ?? self.sessionDefaults?.model)
        guard let selection else { return nil }
        return self.modelChoices.first {
            $0.selectionID == selection || $0.modelID == selection
        }?.contextWindow
    }
}

/// One reply's usage as structured numbers for the footer's context table
/// (web chat-composer-context-panel.tsx:163-264, chat-context-breakdown.tsx).
struct ChatMessageUsagePresentation: Equatable {
    enum Pressure: Equatable {
        case normal
        case warning
        case danger
    }

    enum Component: Hashable {
        case cacheRead
        case cacheWrite
        case input
        case output
    }

    struct Row: Equatable {
        let component: Component
        let tokens: Int
    }

    struct Segment: Equatable {
        /// Nil when only the prompt size is known, not its parts.
        let component: Component?
        /// Share of the bar, which spans the context window.
        let fraction: Double
    }

    struct Context: Equatable {
        let promptTokens: Double
        let windowTokens: Int
        let percent: Int
        let segments: [Segment]
    }

    /// Non-zero counters in display order.
    let rows: [Row]
    let cost: Double?
    let context: Context?

    var pressure: Pressure {
        guard let percent = self.context?.percent else { return .normal }
        if percent >= 90 { return .danger }
        if percent >= 75 { return .warning }
        return .normal
    }

    static func make(
        message: OpenClawChatMessage,
        contextWindowTokens: Int?) -> ChatMessageUsagePresentation?
    {
        guard message.presentationOwnsFooter, !message.stoppedForToolUse,
              message.role.lowercased() == "assistant", let usage = message.usage else { return nil }

        let input = ChatContextUsageCalculator.positive(usage.input)
        let output = ChatContextUsageCalculator.positive(usage.output)
        let cacheRead = ChatContextUsageCalculator.positive(usage.cacheRead)
        let cacheWrite = ChatContextUsageCalculator.positive(usage.cacheWrite)
        let counters: [(Component, Int?)] = [
            (.cacheRead, cacheRead),
            (.cacheWrite, cacheWrite),
            (.input, input),
            (.output, output),
        ]
        let rows = counters.compactMap { component, tokens in tokens.map { Row(component: component, tokens: $0) } }
        let cost = usage.cost?.total.flatMap { $0 > 0 ? $0 : nil }

        // Context pressure mirrors the Control UI prompt size. Output is response data;
        // input plus cache reads/writes is the context the model received for this run.
        // Whole-turn counters sum several calls, so the latest call's marker wins when present.
        let parts: [(Component, Double)] = [
            (.cacheRead, Double(cacheRead ?? 0)),
            (.cacheWrite, Double(cacheWrite ?? 0)),
            (.input, Double(input ?? 0)),
        ]
        let partsTotal = parts.reduce(0) { $0 + $1.1 }
        let promptTokens = usage.contextUsage.map { Double($0.promptTokens) } ?? partsTotal
        var context: Context?
        if let contextWindowTokens, contextWindowTokens > 0, promptTokens > 0 {
            let percent = Int(min(100, (promptTokens / Double(contextWindowTokens) * 100).rounded()))
            // Parts never draw past the prompt they make up, nor the prompt past the bar.
            let denominator = max(Double(contextWindowTokens), promptTokens)
            let segments = partsTotal > 0
                ? parts.filter { $0.1 > 0 }.map {
                    Segment(component: $0.0, fraction: $0.1 * min(1, promptTokens / partsTotal) / denominator)
                }
                : [Segment(component: nil, fraction: promptTokens / denominator)]
            context = Context(
                promptTokens: promptTokens,
                windowTokens: contextWindowTokens,
                percent: percent,
                segments: segments)
        }

        guard !rows.isEmpty || cost != nil || context != nil else { return nil }
        return ChatMessageUsagePresentation(rows: rows, cost: cost, context: context)
    }

    static func tokens(_ value: Double) -> String {
        ChatCompactTokenCountFormatter.string(value)
    }

    /// Web `formatContextCost` (chat-composer-context-panel.tsx:87-89 over lib/format.ts:268-272):
    /// four decimals below a cent, three below a dollar, else two; a trailing third-decimal zero drops.
    static func cost(_ value: Double) -> String {
        let value = value.isFinite ? value : 0
        let digits = value == 0 ? 2 : value < 0.01 ? 4 : value < 1 ? 3 : 2
        let formatted = value.formatted(
            .currency(code: "USD").locale(Locale(identifier: "en_US")).precision(.fractionLength(digits)))
        return digits == 3 && formatted.hasSuffix("0") ? String(formatted.dropLast()) : formatted
    }
}

enum ChatContextUsageFormatter {
    static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", Double(value) / 1_000_000)
        }
        if value >= 1000 {
            return String(format: "%.1fk", Double(value) / 1000)
        }
        return "\(value)"
    }

    static func cost(_ value: Double) -> String {
        String(format: "$%.2f", value)
    }
}
