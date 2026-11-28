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
                   "windows":[{"label":"Weekly","usedPercent":28}]}]}
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
        var daily = [[String: Any]]()
        var total = 0
        var date = first
        while date <= last, daily.count < 366 {
            let day = calendar.ordinality(of: .day, in: .year, for: date) ?? 1
            let count = (80 + (day * 71) % 320) * (query.agentId == nil ? 3 : 2)
            var entry = totals(count)
            entry["date"] = formatter.string(from: date)
            daily.append(entry)
            total += count
            guard let next = calendar.date(byAdding: .day, value: 1, to: date) else { break }
            date = next
        }
        let stats = totals(total)
        let firstAgent = total * 2 / 3
        let aggregates: [String: Any] = [
            "sessionCount": 8, "messages": [
                "user": daily.count * 2,
                "assistant": daily.count * 3,
                "toolCalls": daily.count * 4,
                "errors": 0,
            ],
            "tools": ["tools": [["name": "Search", "count": daily.count * 4]]], "costDaily": daily,
            "byProvider": [["provider": "Example AI", "totals": stats]], "byChannel": [[
                "channel": "Chat",
                "totals": stats,
            ]],
            "byModel": [
                ["model": "Atlas", "totals": totals(firstAgent)],
                ["model": "Orbit", "totals": totals(total - firstAgent)],
            ],
            "byAgent": [
                ["agentId": "Research", "totals": totals(firstAgent)],
                ["agentId": "Writing", "totals": totals(total - firstAgent)],
            ],
        ]
        return try JSONSerialization.data(withJSONObject: [
            "startDate": query.startDate, "endDate": query.endDate, "totals": stats, "aggregates": aggregates,
            "sessions": [["key": "project", "label": "Project notes", "usage": totals(firstAgent)]],
        ])
    }
}
#endif
