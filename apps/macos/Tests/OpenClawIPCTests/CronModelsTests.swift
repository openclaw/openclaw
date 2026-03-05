import Foundation
import Testing
@testable import OpenClaw

@Suite
struct CronModelsTests {
    private func makeCronJob(
        name: String,
        payloadText: String,
        state: CronJobState = CronJobState()) -> CronJob
    {
        CronJob(
            id: "x",
            agentId: nil,
            name: name,
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: .at(at: "2026-02-03T18:00:00Z"),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: payloadText),
            delivery: nil,
            state: state)
    }

    @Test func scheduleAtEncodesAndDecodes() throws {
        let schedule = CronSchedule.at(at: "2026-02-03T18:00:00Z")
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func scheduleAtDecodesLegacyAtMs() throws {
        let json = """
        {"kind":"at","atMs":1700000000000}
        """
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: Data(json.utf8))
        if case let .at(at) = decoded {
            #expect(at.hasPrefix("2023-"))
        } else {
            #expect(Bool(false))
        }
    }

    @Test func scheduleEveryEncodesAndDecodesWithAnchor() throws {
        let schedule = CronSchedule.every(everyMs: 5000, anchorMs: 10000)
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func scheduleCronEncodesAndDecodesWithTimezone() throws {
        let schedule = CronSchedule.cron(expr: "*/5 * * * *", tz: "Europe/Vienna")
        let data = try JSONEncoder().encode(schedule)
        let decoded = try JSONDecoder().decode(CronSchedule.self, from: data)
        #expect(decoded == schedule)
    }

    @Test func payloadAgentTurnEncodesAndDecodes() throws {
        let payload = CronPayload.agentTurn(
            message: "hello",
            thinking: "low",
            timeoutSeconds: 15,
            deliver: true,
            channel: "whatsapp",
            to: "+15551234567",
            bestEffortDeliver: false)
        let data = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(CronPayload.self, from: data)
        #expect(decoded == payload)
    }

    @Test func jobEncodesAndDecodesDeleteAfterRun() throws {
        let job = CronJob(
            id: "job-1",
            agentId: nil,
            name: "One-shot",
            description: nil,
            enabled: true,
            deleteAfterRun: true,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: .at(at: "2026-02-03T18:00:00Z"),
            sessionTarget: .main,
            wakeMode: .now,
            payload: .systemEvent(text: "ping"),
            delivery: nil,
            state: CronJobState())
        let data = try JSONEncoder().encode(job)
        let decoded = try JSONDecoder().decode(CronJob.self, from: data)
        #expect(decoded.deleteAfterRun == true)
    }

    @Test func scheduleDecodeRejectsUnknownKind() {
        let json = """
        {"kind":"wat","at":"2026-02-03T18:00:00Z"}
        """
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(CronSchedule.self, from: Data(json.utf8))
        }
    }

    @Test func payloadDecodeRejectsUnknownKind() {
        let json = """
        {"kind":"wat","text":"hello"}
        """
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(CronPayload.self, from: Data(json.utf8))
        }
    }

    @Test func displayNameTrimsWhitespaceAndFallsBack() {
        let base = makeCronJob(name: "  hello  ", payloadText: "hi")
        #expect(base.displayName == "hello")

        var unnamed = base
        unnamed.name = "   "
        #expect(unnamed.displayName == "Untitled job")
    }

    @Test func nextRunDateAndLastRunDateDeriveFromState() {
        let job = makeCronJob(
            name: "t",
            payloadText: "hi",
            state: CronJobState(
                nextRunAtMs: 1_700_000_000_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: nil,
                lastError: nil,
                lastDurationMs: nil))
        #expect(job.nextRunDate == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(job.lastRunDate == Date(timeIntervalSince1970: 1_700_000_050))
    }
}
