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

    static var nativeChildChat: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-native-child-chat-fixture")
    }

    static var headerFailure: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-subagent-header-failure")
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

    static var pullRequestsOnly: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-activity-fixture-pr-only")
    }

    struct Child {
        let id: String
        let name: String
        let status: String
        let order: String
        let reply: String
        let minutesAgo: Double
        let runtimeMinutes: Double?

        var waitsForContinuation: Bool {
            self.id == "flights" && ProcessInfo.processInfo.arguments.contains("--openclaw-subagent-waiting-fixture")
        }

        var provider: String {
            ActivityPillsFixture.nativeChildChat && self.id == "packing" ? "openai" : "anthropic"
        }

        var model: String {
            self.provider == "openai" ? "gpt-4.1" : "claude-opus-4-1"
        }

        var key: String {
            "agent:main:subagent:activity-\(self.id)"
        }
    }

    static var children: [Child] {
        if ProcessInfo.processInfo.arguments.contains("--openclaw-subagent-count-boundary") {
            let active = (0..<8).map { index in
                Child(
                    id: "route-\(index)",
                    name: "Compare route \(index + 1)",
                    status: "running",
                    order: "Compare two routes",
                    reply: "",
                    minutesAgo: 4,
                    runtimeMinutes: nil)
            }
            return self.tripChildren + active + self.finishedTrips.prefix(98)
        }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-subagent-scroll-fixture") {
            return self.tripChildren + self.finishedTrips
        }
        if self.nativeChildChat {
            return [
                Child(
                    id: "flights",
                    name: "Compare nonstop flights from San Francisco to Lisbon",
                    status: "running",
                    order: "Compare round-trip flights for May 14–21. Check which fares include a checked bag, "
                        + "and tell me whether leaving a day earlier saves enough to cover an extra night in Lisbon.",
                    reply: "I found two nonstop options. I’m checking the baggage fees before comparing the totals.",
                    minutesAgo: 6,
                    runtimeMinutes: nil),
                self.tripChildren[1],
                Child(
                    id: "packing",
                    name: "Find the first train to Sintra",
                    status: "done",
                    order: "Find the first train from Rossio that gets us to Sintra before the palace opens.",
                    reply: "Take the 7:41 from Rossio. It arrives at 8:21, leaving 39 minutes before the palace opens.",
                    minutesAgo: 12,
                    runtimeMinutes: 3),
                Child(
                    id: "tickets",
                    name: "Check tickets for the palace",
                    status: "failed",
                    order: "Check whether two morning tickets are still available for May 17.",
                    reply: "",
                    minutesAgo: 15,
                    runtimeMinutes: 2),
            ]
        }
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-subagents-tabs-fixture") else {
            return self.tripChildren
        }
        return self.tripChildren + [
            Child(
                id: "river",
                name: "Find a quiet place to stay near the river in Lisbon",
                status: "running",
                order: "Find a quiet rental within walking distance of the river.",
                reply: "Checking the shortlist.",
                minutesAgo: 6,
                runtimeMinutes: nil),
            Child(
                id: "train",
                name: "Look up trains to Sintra",
                status: "done",
                order: "Find the earliest train to Sintra.",
                reply: "The first option leaves before breakfast.",
                minutesAgo: 30,
                runtimeMinutes: 4),
            Child(
                id: "tickets",
                name: "Check museum tickets",
                status: "failed",
                order: "Check the museum’s ticket availability.",
                reply: "The ticket office didn’t respond.",
                minutesAgo: 15,
                runtimeMinutes: 3),
            Child(
                id: "walk",
                name: "Map the waterfront walk",
                status: "done",
                order: "Find a short waterfront route.",
                reply: "The route ends at the ferry terminal.",
                minutesAgo: 11,
                runtimeMinutes: 3),
            Child(
                id: "lunch",
                name: "Find lunch near the station",
                status: "stopped",
                order: "Find a lunch stop near the station.",
                reply: "I’ll stop here.",
                minutesAgo: 7,
                runtimeMinutes: 2),
        ]
    }

    /// A long Finished segment and a Running segment that fits without scrolling.
    private static let finishedTrips: [Child] = (0..<121).map { index in
        let destinations = ["Sintra", "Cascais", "Porto", "Coimbra", "Évora", "Aveiro", "Faro"]
        let stops = ["train times", "museum tickets", "walking routes", "ferry departures", "hotel availability"]
        let place = destinations[index % destinations.count]
        let title = "Check \(stops[(index / destinations.count) % stops.count]) in \(place)"
        return Child(
            id: "visit-\(index)",
            name: title,
            status: index.isMultiple(of: 4) ? "failed" : "done",
            order: title,
            reply: "",
            minutesAgo: Double(index + 20),
            runtimeMinutes: 3)
    }

    private static let tripChildren: [Child] = [
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

    static var initialGoal: OpenClawChatSessionGoal? {
        guard self.isEnabled, !self.pullRequestsOnly else { return nil }
        let now = Date().timeIntervalSince1970 * 1000
        if ProcessInfo.processInfo.arguments.contains("--openclaw-goal-controls-fixture") {
            return OpenClawChatSessionGoal(
                id: "goal-release",
                objective: "Draft a 500-character summary of the release plan.",
                status: .active,
                createdAt: now - 31000,
                updatedAt: now,
                tokensUsed: 660)
        }
        return OpenClawChatSessionGoal(
            id: "goal-lisbon",
            objective: "Plan a week in Lisbon for two in mid-May: flights from SFO, a quiet hotel near Alfama, "
                + "and a day-by-day outline with one day trip to Sintra.",
            status: .active,
            createdAt: now - 47 * 60 * 1000,
            updatedAt: now - 2 * 60 * 1000,
            tokensUsed: 184_000,
            tokenBudget: 500_000,
            lastStatusNote: "Flights and hotels are being compared in parallel. The outline waits on both.")
    }

    private static let fixtureStart = Date().timeIntervalSince1970 * 1000

    static func decorate(
        sessions: inout [OpenClawChatSessionEntry],
        parentKey: String,
        stoppedAt: [String: Double] = [:])
    {
        guard self.isEnabled, !self.pullRequestsOnly, !self.goalOnly, !sessions.isEmpty else { return }
        sessions[0].hasActiveSubagentRun = self.children.contains { $0.status == "running" && stoppedAt[$0.key] == nil }
        let parent = sessions[0].key
        for (index, child) in self.children.enumerated() {
            let started = self.fixtureStart - child.minutesAgo * 60 * 1000
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
            row.sessionId = "fixture-child-\(child.id)"
            row.activeRunIds = child.status == "running" ? ["fixture-run-\(child.id)"] : []
            if child.waitsForContinuation {
                row.status = "done"
                row.subagentRunState = "paused"
                row.hasActiveRun = false
                row.hasActiveSubagentRun = false
                row.activeRunIds = []
            }
            if let end = stoppedAt[child.key] {
                row.subagentRunState = "historical"
                row.status = self.headerFailure && child.id == "flights" ? "failed" : "aborted"
                row.hasActiveRun = false
                row.activeRunIds = []
                row.endedAt = end
                row.runtimeMs = end - started
            }
            row.modelProvider = child.provider
            row.model = child.model
            row.createdAt = started - Double(index)
            sessions.append(row)
        }
    }

    static func progressCard(sessionKey: String) -> ProgressCard? {
        guard self.isEnabled, !self.pullRequestsOnly, !self.goalOnly,
              self.child(forKey: sessionKey) == nil else { return nil }
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

    static func history(
        sessionKey: String,
        stopped: Bool = false,
        liveText: String? = nil) async throws -> OpenClawChatHistoryPayload?
    {
        guard self.isEnabled, let child = self.child(forKey: sessionKey) else { return nil }
        if self.holdsReads { try await Task.sleep(for: .seconds(120)) }
        if self.failsReads { throw URLError(.notConnectedToInternet) }
        let now = Date().timeIntervalSince1970 * 1000
        let order = child.order
        var messages: [[String: Any]] = [
            ["role": "user", "content": order, "timestamp": now - child.minutesAgo * 60 * 1000],
            ["role": "assistant", "content": [["type": "text", "text": child.reply]], "timestamp": now - 30000],
        ]
        if child.id == "packing" {
            // A finished child may have a one-line, unterminated context message before its actual order.
            messages.insert([
                "role": "user", "content": "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
                "timestamp": now - child.minutesAgo * 60 * 1000 - 1,
            ], at: 0)
        }
        if self.nativeChildChat {
            let run = "fixture-run-\(child.id)"
            let start = self.fixtureStart - child.minutesAgo * 60000
            let done = child.status != "running" || stopped
            let tool = child.id == "flights" ? "web_search" : "web_fetch"
            let query = child.id == "flights" ? "SFO to Lisbon nonstop fares" : child
                .id == "packing" ? "Rossio to Sintra timetable" : "Palace ticket availability"
            let result = child.id == "flights" ? "Two nonstop itineraries found" : child
                .id == "packing" ? "First departure: 7:41" : "The ticket office didn’t respond"
            func record(_ role: String, _ id: String, _ offset: Double, _ fields: [String: Any]) -> [String: Any] {
                var payload = fields
                if role == "assistant" {
                    payload["model"] = child.model
                    payload["provider"] = child.provider
                }
                return payload.merging([
                    "role": role,
                    "timestamp": start + offset,
                    "__openclaw": ["id": id, "runId": run, "recordTimestampMs": start + offset],
                ]) { a, _ in a }
            }
            let call = "\(child.id)-search"
            messages = [
                record("user", "\(child.id)-request", 0, ["content": [["type": "text", "text": order]]]),
                record("assistant", call, 1800, ["stopReason": "toolUse", "content": [[
                    "type": "toolCall",
                    "id": call,
                    "name": tool,
                    "arguments": ["query": query],
                ]]]),
                record(
                    "toolResult",
                    "\(call)-result",
                    8000,
                    [
                        "toolCallId": call,
                        "toolName": tool,
                        "isError": child.status == "failed",
                        "content": [["type": "text", "text": result]],
                    ]),
            ]
            if !child.reply.isEmpty {
                messages.append(record(
                    "assistant",
                    "\(child.id)-reply",
                    child.runtimeMinutes.map { $0 * 60000 } ?? 14000,
                    [
                        "content": [["type": "text", "text": child.reply]],
                        "stopReason": child
                            .status == "running" ? "toolUse" :
                            "stop",
                    ]))
            }
            if child.id == "flights" {
                let comparisons = [
                    (
                        "Flight schedules",
                        "The overnight flight lands before lunch. Both return flights leave early "
                            + "enough to reach San Francisco the same afternoon."),
                    (
                        "Outbound seats on May 13",
                        "Leaving a day earlier opens a lower fare on the same nonstop route. I’m "
                            + "checking that fare against the extra hotel night, not just the cheaper ticket."),
                    (
                        "Alfama hotel rates for May 14",
                        "The hotel lists its local tax separately. I’ve included it in the extra "
                            + "night so the comparison uses the complete price for two people."),
                    (
                        "Fare conditions for two adults",
                        "Both quotes include one cabin bag per person. The second airline lists "
                            +
                            "checked luggage under extras. I’m verifying the charge before totaling both fares."),
                ]
                for (index, pair) in comparisons.enumerated() {
                    let id = "fare-\(index)"
                    let time = Double(20000 + index * 40000)
                    messages.append(record("assistant", id, time, ["stopReason": "toolUse", "content": [[
                        "type": "toolCall", "id": id, "name": "web_search", "arguments": ["query": pair.0],
                    ]]]))
                    messages.append(record("toolResult", id + "-result", time + 1800, [
                        "toolCallId": id, "toolName": "web_search", "content": [["type": "text", "text": pair.0]],
                    ]))
                    messages.append(record("assistant", id + "-note", time + 3000, [
                        "stopReason": "toolUse", "content": [["type": "text", "text": pair.1]],
                    ]))
                }
            }
            if child.id == "packing", ProcessInfo.processInfo.arguments.contains("--openclaw-subagent-code-swipe") {
                let code = "let departureTimes = [" + (1...35).map { String($0) }.joined(separator: ", ") + "]"
                messages.append(record("assistant", "train-code", 179_000, ["stopReason": "stop", "content": [[
                    "type": "text", "text": "```swift\n" + code + "\n```",
                ]]]))
            }
            if stopped, let liveText {
                messages.append(record(
                    "assistant",
                    "\(child.id)-partial",
                    170_000,
                    ["content": [["type": "text", "text": liveText]], "stopReason": "aborted"]))
            }
            let data = try JSONSerialization.data(withJSONObject: messages)
            return try OpenClawChatHistoryPayload(
                sessionKey: sessionKey,
                sessionId: "fixture-child-\(child.id)",
                messages: JSONDecoder().decode([AnyCodable].self, from: data),
                thinkingLevel: nil,
                sessionInfo: .init(
                    hasActiveRun: !done,
                    activeRunIds: done ? [] : [run],
                    key: sessionKey,
                    agentId: "main"),
                inFlightRun: done ? nil : .init(runId: run, text: liveText ?? ""))
        }
        let data = try JSONSerialization.data(withJSONObject: messages)
        let rows = try JSONDecoder().decode([AnyCodable].self, from: data)
        return OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "activity-\(child.id)",
            messages: rows,
            thinkingLevel: nil)
    }

    static func childSessions(
        parentKey: String,
        stoppedAt: [String: Double] = [:]) async throws -> OpenClawChatChildSessionsResult?
    {
        guard self.isEnabled, !self.pullRequestsOnly, !self.goalOnly else { return nil }
        if self.holdsReads { try await Task.sleep(for: .seconds(120)) }
        if self.failsReads { throw URLError(.notConnectedToInternet) }
        var rows = [OpenClawChatSessionEntry(key: parentKey)]
        self.decorate(sessions: &rows, parentKey: parentKey, stoppedAt: stoppedAt)
        return OpenClawChatChildSessionsResult(rows: Array(rows.dropFirst()), isComplete: true)
    }

    static func pullRequests() -> OpenClawSessionPullRequestSnapshot {
        if self.pullRequestsOnly {
            let alternate = ProcessInfo.processInfo.arguments.contains("--openclaw-activity-fixture-pr-alternate")
            let owner = "paper-trail"
            let repo = "review-notes"
            func pr(
                _ number: Int,
                _ state: String,
                _ branch: String,
                _ title: String,
                _ checks: OpenClawSessionPullRequestSnapshot.Checks? = nil)
                -> OpenClawSessionPullRequestSnapshot.PullRequest
            {
                .init(
                    number: number,
                    owner: owner,
                    repo: repo,
                    branch: branch,
                    title: title,
                    url: "https://github.com/\(owner)/\(repo)/pull/\(number)",
                    state: state,
                    additions: 86,
                    deletions: 17,
                    changedFiles: 3,
                    checks: checks,
                    author: .init(login: "paperbird"))
            }
            return .init(pullRequests: [
                pr(
                    148,
                    "open",
                    "fix/preserve-review-previews",
                    "Keep preview links attached when the review branch changes",
                    alternate
                        ? .init(state: "pending", passed: 3, failed: 0, skipped: 0, running: 1)
                        : .init(state: "passing", passed: 4, failed: 0, skipped: 0, running: 0)),
                pr(32, "draft", "docs/preview-notes", "Describe the review preview"),
                pr(
                    7,
                    "open",
                    "fix/preview-title",
                    "Restore preview titles when a reviewer switches branches and reopens an archived conversation",
                    .init(state: "failing", passed: 2, failed: 1, skipped: 0, running: 0)),
                pr(9, alternate ? "closed" : "merged", "fix/review-links", "Keep the original review link"),
            ])
        }
        return OpenClawSessionPullRequestSnapshot(
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

extension LocalFixtureChatStore {
    func childSnapshot(_ key: String) -> (stopped: Bool, liveText: String?) {
        if ActivityPillsFixture.child(forKey: key)?.id == "flights", self.stoppedChildAt[key] == nil,
           self.scheduledChildDelta.insert(key).inserted
        {
            Task {
                try? await Task.sleep(for: .seconds(2))
                guard self.stoppedChildAt[key] == nil else { return }
                let text = "The first fare includes a checked bag. The second adds $75 each way."
                self.childLiveText[key] = text
                self.publish(.chat(.init(
                    runId: "fixture-run-flights",
                    sessionKey: key,
                    state: "delta",
                    message: AnyCodable(["role": "assistant", "content": text]),
                    errorMessage: nil)))
                if ActivityPillsFixture.headerFailure {
                    try? await Task.sleep(for: .seconds(6))
                    guard self.stoppedChildAt[key] == nil else { return }
                    self.recordChildEnd(key: key, runID: "fixture-run-flights", error: "The fare lookup failed")
                }
            }
        }
        return (self.stoppedChildAt[key] != nil, self.childLiveText[key])
    }

    func stopChild(_ target: OpenClawChildStopTarget) throws -> Data {
        guard let child = ActivityPillsFixture.child(forKey: target.key), child.status == "running",
              target.runID == (child.waitsForContinuation ? nil : "fixture-run-\(child.id)"),
              self.stoppedChildAt[target.key] == nil
        else {
            return Data(#"{"ok":true,"abortedRunId":null,"status":"no-active-run"}"#.utf8)
        }
        let runID = "fixture-run-\(child.id)"
        self.recordChildEnd(key: target.key, runID: runID)
        return try JSONSerialization.data(withJSONObject: [
            "ok": true,
            "status": "aborted",
            "abortedRunId": runID,
        ])
    }
}
