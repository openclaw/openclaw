import Foundation
import OpenClawProtocol

struct CronJobsListLite: Decodable {
    let jobs: [CronJob]
    let total: Int?
    let hasMore: Bool
    let nextOffset: Int?

    private enum CodingKeys: String, CodingKey {
        case jobs
        case total
        case hasMore
        case nextOffset
    }

    init(
        jobs: [CronJob],
        total: Int?,
        hasMore: Bool,
        nextOffset: Int?)
    {
        self.jobs = jobs
        self.total = total
        self.hasMore = hasMore
        self.nextOffset = nextOffset
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.jobs = try container.decode([CronJob].self, forKey: .jobs)
        self.total = try container.decodeIfPresent(Int.self, forKey: .total)
        self.hasMore = try container.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
        self.nextOffset = try container.decodeIfPresent(Int.self, forKey: .nextOffset)
    }

    @MainActor
    static func collect(
        maximumPageCount: Int,
        maximumJobCount: Int,
        fetchPage: @MainActor (Int) async -> CronJobsListLite?) async -> CronJobsListLite?
    {
        var jobs: [CronJob] = []
        var seenJobIDs: Set<String> = []
        var offset = 0
        for _ in 0..<maximumPageCount {
            guard let page = await fetchPage(offset),
                  page.total.map({ (0...maximumJobCount).contains($0) }) ?? true
            else { return nil }
            // Concurrent edits can shift offset pages. Keep the first copy; the next refresh picks up changes.
            jobs.append(contentsOf: page.jobs.filter { seenJobIDs.insert($0.id).inserted })
            guard jobs.count <= maximumJobCount else { return nil }
            guard page.hasMore else {
                return CronJobsListLite(
                    jobs: jobs,
                    total: page.total == jobs.count ? page.total : nil,
                    hasMore: false,
                    nextOffset: nil)
            }
            guard let nextOffset = page.nextOffset,
                  nextOffset > offset,
                  nextOffset <= maximumJobCount
            else { return nil }
            offset = nextOffset
        }
        return nil
    }
}

enum CostUsageRequest {
    static func monthParamsJSON(timeZone: TimeZone = .current, date: Date = Date()) -> String {
        let offsetMinutes = timeZone.secondsFromGMT(for: date) / 60
        let absoluteMinutes = abs(offsetMinutes)
        let minuteSuffix = absoluteMinutes.isMultiple(of: 60)
            ? ""
            : String(format: ":%02d", absoluteMinutes % 60)
        let utcOffset = "UTC\(offsetMinutes < 0 ? "-" : "+")\(absoluteMinutes / 60)\(minuteSuffix)"
        let params: [String: Any] = [
            "days": 31,
            "mode": "specific",
            "timeZone": timeZone.identifier,
            "utcOffset": utcOffset,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: params, options: [.sortedKeys]) else {
            return #"{"days":31,"mode":"gateway"}"#
        }
        return String(bytes: data, encoding: .utf8)!
    }
}

struct CostUsageSummaryLite: Decodable {
    let daily: [CostUsageDailyEntryLite]?
    let totals: [String: AnyCodable]?

    var totalCost: Double? {
        switch self.totals?["totalCost"]?.value {
        case let double as Double where double.isFinite: double
        case let int as Int: Double(int)
        case let string as String: Double(string)
        default: nil
        }
    }
}

struct CostUsageDailyEntryLite: Decodable {
    let date: String
    let totalCost: Double?
}
