#if DEBUG
import Foundation

/// Synthetic RPC responses for the screenshot-mode UI test. Never used by a connected installation.
enum NativeUsagePreview {
    static var isEnabled: Bool {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.contains("--openclaw-screenshot-mode") && arguments.contains("--openclaw-usage-fixture")
    }

    static let plans = #"""
    {"providers":[{"displayName":"Example AI","plan":"Team",
                   "windows":[{"label":"Weekly","usedPercent":28}],
                   "billing":[{"type":"balance","amount":72,"unit":"credits"}]}]}
    """#

    static func report(_ query: NativeUsageQuery) throws -> Data {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: query.timeZone)
        formatter.dateFormat = "yyyy-MM-dd"
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = formatter.timeZone
        guard let first = formatter.date(from: query.startDate), let last = formatter.date(from: query.endDate) else {
            throw CocoaError(.coderInvalidValue)
        }
        func totals(_ n: Int) -> [String: Any] {
            [
                "input": n * 5,
                "output": n * 2,
                "cacheRead": n * 3,
                "cacheWrite": 0,
                "totalTokens": n * 10,
                "totalCost": Double(n) / 50000,
                "missingCostEntries": 0,
            ]
        }
        let share = query.agentId == nil ? 3 : query.agentId == "Research" ? 2 : 1
        var daily = [[String: Any]]()
        var total = 0
        var date = first
        while date <= last, daily.count < 366 {
            let day = calendar.ordinality(of: .day, in: .year, for: date) ?? 1
            let count = (80 + (day * 71) % 320) * share
            var entry = totals(count)
            entry["date"] = formatter.string(from: date)
            daily.append(entry)
            total += count
            guard let next = calendar.date(byAdding: .day, value: 1, to: date) else { break }
            date = next
        }
        let stats = totals(total)
        let firstAgent = total * 2 / 3
        let agents: [[String: Any]] = if let id = query.agentId {
            [["agentId": id, "totals": stats]]
        } else {
            [
                ["agentId": "Research", "totals": totals(firstAgent)],
                ["agentId": "Writing", "totals": totals(total - firstAgent)],
            ]
        }
        let calls = daily.count * 2 * share
        let aggregates: [String: Any] = [
            "sessionCount": share == 3 ? 8 : share == 2 ? 5 : 3, "messages": [
                "user": daily.count * share,
                "assistant": daily.count * 2 * share,
                "toolCalls": calls,
                "errors": 0,
            ],
            "tools": ["tools": [["name": "Search", "count": calls]]], "costDaily": daily,
            "byProvider": [["provider": "Example AI", "totals": stats]], "byChannel": [[
                "channel": "Chat",
                "totals": stats,
            ]],
            "byModel": [
                ["model": "Atlas", "totals": totals(firstAgent)],
                ["model": "Orbit", "totals": totals(total - firstAgent)],
            ],
            "byAgent": agents,
        ]
        return try JSONSerialization.data(withJSONObject: [
            "startDate": query.startDate, "endDate": query.endDate, "totals": stats, "aggregates": aggregates,
            "sessions": [["key": "project", "label": "Project notes", "usage": totals(firstAgent)]],
        ])
    }
}
#endif
