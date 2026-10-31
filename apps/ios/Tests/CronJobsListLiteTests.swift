import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct CronJobsListLiteTests {
    @Test @MainActor func `cron collector preserves page order`() async throws {
        let collected = await Self.collectCronPages([
            Self.cronPage(["z", "a"], total: 3, hasMore: true, nextOffset: 2),
            Self.cronPage(["m"], total: 3),
        ], maximumPageCount: 2)
        let snapshot = try #require(collected.snapshot)

        #expect(collected.offsets == [0, 2])
        #expect(snapshot.jobs.map(\.id) == ["z", "a", "m"])
        #expect(snapshot.total == 3)
        #expect(!snapshot.hasMore)
        #expect(snapshot.nextOffset == nil)
    }

    @Test @MainActor func `cron collector accepts empty advancing pages`() async throws {
        let collected = await Self.collectCronPages([
            Self.cronPage(hasMore: true, nextOffset: 3),
            Self.cronPage(["a"], nextOffset: 99),
        ])
        let snapshot = try #require(collected.snapshot)

        #expect(collected.offsets == [0, 3])
        #expect(snapshot.jobs.map(\.id) == ["a"])
        #expect(snapshot.total == nil)
        #expect(!snapshot.hasMore)
        #expect(snapshot.nextOffset == nil)
    }

    @Test func `legacy cron list defaults to a single page`() throws {
        let page = try JSONDecoder().decode(
            CronJobsListLite.self,
            from: Data(#"{"jobs":[],"total":0}"#.utf8))
        #expect(!page.hasMore)
        #expect(page.nextOffset == nil)
    }

    @Test @MainActor func `cron collector tolerates edits between pages`() async throws {
        for total in [3, nil] as [Int?] {
            let collected = await Self.collectCronPages([
                Self.cronPage(["a"], total: 2, hasMore: true, nextOffset: 1),
                Self.cronPage(["a", "b"], total: total),
            ])
            #expect(try #require(collected.snapshot).jobs.map(\.id) == ["a", "b"])
            #expect(collected.offsets == [0, 1])
        }
    }

    @Test @MainActor func `cron collector rejects oversized or unavailable pages`() async {
        let first = Self.cronPage(["a"], hasMore: true, nextOffset: 1)
        let cases: [(name: String, pages: [CronJobsListLite?], offsets: [Int])] = [
            ("negative total", [Self.cronPage(total: -1)], [0]),
            ("page exceeds job budget", [Self.cronPage(["a", "b", "c", "d"])], [0]),
            ("aggregate exceeds job budget", [
                Self.cronPage(["a", "b"], hasMore: true, nextOffset: 2), Self.cronPage(["c", "d"]),
            ], [0, 2]),
            ("first fetch unavailable", [nil], [0]),
            ("later fetch unavailable", [first, nil], [0, 1]),
        ]
        for scenario in cases {
            let collected = await Self.collectCronPages(scenario.pages)
            #expect(collected.snapshot == nil, "\(scenario.name)")
            #expect(collected.offsets == scenario.offsets, "\(scenario.name)")
        }
    }

    @Test @MainActor func `cron collector rejects missing nonadvancing and over-budget offsets`() async {
        let firstOffsets: [Int?] = [nil, -1, 0, 4]
        for nextOffset in firstOffsets {
            let collected = await Self.collectCronPages([
                Self.cronPage(["a"], hasMore: true, nextOffset: nextOffset),
            ])
            #expect(collected.snapshot == nil)
            #expect(collected.offsets == [0])
        }
        for nextOffset in [0, 1, 2] {
            let collected = await Self.collectCronPages([
                Self.cronPage(["a"], hasMore: true, nextOffset: 2),
                Self.cronPage(["b"], hasMore: true, nextOffset: nextOffset),
            ])
            #expect(collected.snapshot == nil)
            #expect(collected.offsets == [0, 2])
        }
    }

    @Test @MainActor func `cron collector preserves terminal metadata at configured budgets`() async throws {
        let empty = await Self.collectCronPages([Self.cronPage(total: 0)])
        #expect(empty.offsets == [0])
        #expect(empty.snapshot?.jobs.isEmpty == true)
        #expect(empty.snapshot?.total == 0)

        for limits in [(pages: 5, jobs: 1000), (pages: 100, jobs: 20000)] {
            var pages: [CronJobsListLite?] = (1...limits.pages).map {
                Self.cronPage(total: limits.jobs, hasMore: true, nextOffset: $0)
            }
            let exhausted = await Self.collectCronPages(
                pages, maximumPageCount: limits.pages, maximumJobCount: limits.jobs)
            #expect(exhausted.snapshot == nil)
            #expect(exhausted.offsets == Array(0..<limits.pages))

            pages[limits.pages - 1] = Self.cronPage(["a"], total: limits.jobs)
            let completed = await Self.collectCronPages(
                pages, maximumPageCount: limits.pages, maximumJobCount: limits.jobs)
            let snapshot = try #require(completed.snapshot)
            #expect(completed.offsets == Array(0..<limits.pages))
            #expect(snapshot.jobs.map(\.id) == ["a"])
            #expect(snapshot.total == nil)
            #expect(!snapshot.hasMore)
            #expect(snapshot.nextOffset == nil)

            let oversized = await Self.collectCronPages(
                [Self.cronPage(total: limits.jobs + 1)],
                maximumPageCount: limits.pages, maximumJobCount: limits.jobs)
            #expect(oversized.snapshot == nil)
            #expect(oversized.offsets == [0])
        }
    }

    @MainActor
    private static func collectCronPages(
        _ pages: [CronJobsListLite?],
        maximumPageCount: Int = 3,
        maximumJobCount: Int = 3) async -> (snapshot: CronJobsListLite?, offsets: [Int])
    {
        var offsets: [Int] = []
        let snapshot = await CronJobsListLite.collect(
            maximumPageCount: maximumPageCount,
            maximumJobCount: maximumJobCount)
        { offset in
            let index = offsets.count
            offsets.append(offset)
            return index < pages.count ? pages[index] : nil
        }
        return (snapshot, offsets)
    }

    private static func cronPage(
        _ ids: [String] = [],
        total: Int? = nil,
        hasMore: Bool = false,
        nextOffset: Int? = nil) -> CronJobsListLite
    {
        CronJobsListLite(
            jobs: ids.map { Self.job(id: $0) },
            total: total,
            hasMore: hasMore,
            nextOffset: nextOffset)
    }

    private static func job(id: String) -> CronJob {
        CronJob(
            id: id,
            name: "Release briefing",
            description: "Daily mobile release overview",
            enabled: true,
            deleteafterrun: false,
            createdatms: 1_783_468_800_000,
            updatedatms: 1_783_555_200_000,
            configrevision: "sha256:test-revision",
            schedule: AnyCodable([
                "kind": AnyCodable("every"),
                "everyMs": AnyCodable(86_400_000),
                "anchorMs": AnyCodable(1_783_468_800_000),
            ]),
            sessiontarget: AnyCodable("isolated"),
            wakemode: AnyCodable("now"),
            payload: AnyCodable([
                "kind": AnyCodable("agentTurn"),
                "message": AnyCodable("Summarize release readiness."),
                "model": AnyCodable("openai/gpt-5.2"),
            ]),
            state: [:],
            nextrunatms: 1_783_641_600_000)
    }
}
