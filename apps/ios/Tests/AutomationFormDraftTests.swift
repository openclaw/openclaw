import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct AutomationFormDraftTests {
    @Test func `weekday schedule uses the editors time zone`() throws {
        let now = try Date("2026-11-28T20:00:00Z", strategy: .iso8601)
        let draft = try AutomationFormDraft(now: now, zone: #require(TimeZone(identifier: "America/Sao_Paulo")))
        var edited = draft
        edited.name = "Afternoon update"
        edited.instructions = "Summarize the day."
        edited.date = now
        edited.frequency = .weekdays
        let params = try edited.parameters(job: nil, original: draft, agentID: "main", now: now)
        let schedule = try #require(params["schedule"]?.value as? AutomationGateway.Params)
        #expect(schedule["expr"]?.stringValue == "0 17 * * 1-5")
        #expect(schedule["tz"]?.stringValue == "America/Sao_Paulo")
        #expect(schedule["staggerMs"]?.intValue == 0)
    }

    @Test func `renaming preserves unknown schedule and payload options`() throws {
        let job = try JSONDecoder().decode(
            AutomationGateway.Definition.self,
            from: Data(
                """
                {
                  "id": "one", "name": "Original", "enabled": true, "configRevision": "v1",
                  "sessionTarget": "isolated", "schedule": {"kind": "event", "source": "inbox", "options": {}},
                  "payload": {"kind": "agentTurn", "message": "Review notes", "model": "some-model"}
                }
                """.utf8))
        let baseline = AutomationFormDraft(job: job)
        var edited = baseline
        edited.name = "New name"
        let params = try edited.parameters(job: job, original: baseline, agentID: nil)
        #expect(params["expectedConfigRevision"]?.stringValue == "v1")
        let patch = try #require(params["patch"]?.value as? AutomationGateway.Params)
        #expect(Set(patch.keys) == ["name"])
    }
}
