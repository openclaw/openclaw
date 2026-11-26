import Foundation
import OpenClawChatUI
import OpenClawProtocol

/// `--openclaw-activity-fixture`: a chat with a Goal, a plan with steps, two working subagents and a finished
/// one, and three linked PRs (open, merged, and one without details), so the activity row and every sheet have real
/// content.
/// `--openclaw-activity-fixture-failures` makes every read behind the sheets fail; `-slow` holds them.
enum ActivityPillsFixture {
    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-activity-fixture")
    }

    static var failsReads: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-activity-fixture-failures")
    }

    static var holdsReads: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-activity-fixture-slow")
    }

    /// The first PR's checks fail instead of running, for the pill's red mark.
    static var failingChecks: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-activity-fixture-failing-checks")
    }

    /// Only the Goal, for the row's smallest state.
    static var goalOnly: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-activity-fixture-goal-only")
    }

    struct Child {
        let id: String
        let name: String
        let status: String
        let order: String
        let reply: String
        let minutesAgo: Double
        let runtimeMinutes: Double?

        var key: String {
            "agent:main:subagent:activity-\(self.id)"
        }
    }

    static let children: [Child] = [
        Child(
            id: "flights",
            name: "Compare flight prices",
            status: "running",
            order: "Compare round-trip fares from SFO to Lisbon for May 14–21. List the three cheapest options with "
                + "airline, stops and total price, and note any fare that includes a checked bag.",
            reply: "Checking fares on three carriers so far. TAP has a nonstop on May 14.",
            minutesAgo: 4,
            runtimeMinutes: nil),
        Child(
            id: "hotels",
            name: "Check hotel reviews",
            status: "running",
            order: "Read recent reviews for the four hotels on the shortlist and flag noise, cleanliness and "
                + "location complaints from the last six months.",
            reply: "Two of the four hotels have repeated complaints about street noise at night.",
            minutesAgo: 3,
            runtimeMinutes: nil),
        Child(
            id: "packing",
            name: "Draft the packing list",
            status: "done",
            order: "Draft a packing list for a week in Lisbon in May, for two adults, carry-on only.",
            reply: "Here’s a carry-on list for two: light layers, one rain jacket each, comfortable walking shoes, "
                + "and a shared adapter.",
            minutesAgo: 12,
            runtimeMinutes: 2.5),
    ]

    static func child(forKey key: String) -> Child? {
        self.children.first { key.hasSuffix("subagent:activity-\($0.id)") }
    }

    static func decorate(sessions: inout [OpenClawChatSessionEntry], parentKey: String) {
        guard self.isEnabled, !sessions.isEmpty else { return }
        let now = Date().timeIntervalSince1970 * 1000
        sessions[0].goal = OpenClawChatSessionGoal(
            id: "goal-lisbon",
            objective: "Plan a week in Lisbon for two in mid-May: flights from SFO, a quiet hotel near Alfama, "
                + "and a day-by-day outline with one day trip to Sintra.",
            status: .active,
            createdAt: now - 47 * 60 * 1000,
            updatedAt: now - 2 * 60 * 1000,
            tokensUsed: 184_000,
            tokenBudget: 500_000,
            lastStatusNote: "Flights and hotels are being compared in parallel. The outline waits on both.")
        guard !self.goalOnly else { return }
        sessions[0].hasActiveSubagentRun = true
        let parent = sessions[0].key
        for (index, child) in self.children.enumerated() {
            let started = now - child.minutesAgo * 60 * 1000
            var row = OpenClawChatSessionEntry(
                key: child.key,
                kind: "direct",
                displayName: child.name,
                classification: "subagent",
                parentSessionKey: parent,
                spawnedBy: parent,
                status: child.status,
                hasActiveRun: child.status == "running",
                startedAt: started,
                endedAt: child.runtimeMinutes.map { started + $0 * 60 * 1000 },
                runtimeMs: child.runtimeMinutes.map { $0 * 60 * 1000 })
            row.createdAt = started - Double(index)
            sessions.append(row)
        }
    }

    static func progressCard(sessionKey: String) -> ProgressCard? {
        guard self.isEnabled, !self.goalOnly else { return nil }
        return ProgressCard(
            sessionkey: sessionKey,
            revision: 3,
            updatedat: 0,
            markdown: nil,
            steps: [
                ProgressCardStep(step: "Collect the trip requirements", status: .completed),
                ProgressCardStep(step: "Shortlist four hotels near Alfama", status: .completed),
                ProgressCardStep(step: "Compare flights and hotel reviews", status: .inProgress),
                ProgressCardStep(step: "Outline each day", status: .pending),
                ProgressCardStep(step: "Book the Sintra day trip", status: .pending),
            ])
    }

    static func history(sessionKey: String) async throws -> OpenClawChatHistoryPayload? {
        guard self.isEnabled, let child = self.child(forKey: sessionKey) else { return nil }
        if self.holdsReads { try await Task.sleep(for: .seconds(120)) }
        if self.failsReads { throw URLError(.notConnectedToInternet) }
        let now = Date().timeIntervalSince1970 * 1000
        let messages: [[String: Any]] = [
            ["role": "user", "content": child.order, "timestamp": now - child.minutesAgo * 60 * 1000],
            ["role": "assistant", "content": [["type": "text", "text": child.reply]], "timestamp": now - 30000],
        ]
        let data = try JSONSerialization.data(withJSONObject: messages)
        let rows = try JSONDecoder().decode([AnyCodable].self, from: data)
        return OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "activity-\(child.id)",
            messages: rows,
            thinkingLevel: nil)
    }

    static func childSessions(parentKey: String) async throws -> OpenClawChatChildSessionsResult? {
        guard self.isEnabled, !self.goalOnly else { return nil }
        if self.holdsReads { try await Task.sleep(for: .seconds(120)) }
        if self.failsReads { throw URLError(.notConnectedToInternet) }
        var rows = [OpenClawChatSessionEntry(key: parentKey)]
        self.decorate(sessions: &rows, parentKey: parentKey)
        return OpenClawChatChildSessionsResult(rows: Array(rows.dropFirst()), isComplete: true)
    }

    static func pullRequests() -> OpenClawSessionPullRequestSnapshot {
        OpenClawSessionPullRequestSnapshot(
            pullRequests: [
                .init(
                    number: 4182,
                    owner: "lisbon-trip",
                    repo: "itinerary",
                    branch: "trip/may-outline",
                    title: "Add the day-by-day outline for May",
                    url: "https://github.com/lisbon-trip/itinerary/pull/4182",
                    state: "open",
                    additions: 214,
                    deletions: 18,
                    changedFiles: 6,
                    checks: self.failingChecks
                        ? .init(state: "failing", passed: 11, failed: 1, skipped: 0, running: 0)
                        : .init(state: "pending", passed: 8, failed: 0, skipped: 0, running: 4),
                    author: .init(login: "molty")),
                .init(
                    number: 4170,
                    owner: "lisbon-trip",
                    repo: "itinerary",
                    branch: "trip/hotel-shortlist",
                    title: "Shortlist four quiet hotels near Alfama",
                    url: "https://github.com/lisbon-trip/itinerary/pull/4170",
                    state: "merged",
                    additions: 96,
                    deletions: 4,
                    changedFiles: 2,
                    author: .init(login: "molty")),
            ],
            // Published by a child; GitHub didn't answer for it, so it carries no details.
            taskPullRequests: [
                .init(
                    url: "https://github.com/lisbon-trip/booking-notes/pull/4191",
                    owner: "lisbon-trip",
                    repo: "booking-notes",
                    number: 4191,
                    branch: "trip/booking"),
            ],
            status: self.failsReads ? "unavailable" : "ready")
    }
}
