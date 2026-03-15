import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CronJobEditorSmokeTests {
    private struct CronJobFixture: Encodable {
        let id: String
        let agentId: String?
        let name: String
        let description: String?
        let enabled: Bool
        let deleteAfterRun: Bool?
        let createdAtMs: Int
        let updatedAtMs: Int
        let schedule: CronSchedule
        let sessionTarget: String
        let wakeMode: CronWakeMode
        let payload: CronPayload
        let delivery: CronDelivery?
        let state: CronJobState
    }

    private func makeCronJob(
        id: String,
        agentId: String?,
        name: String,
        description: String?,
        enabled: Bool,
        deleteAfterRun: Bool?,
        createdAtMs: Int,
        updatedAtMs: Int,
        schedule: CronSchedule,
        sessionTarget: CronCustomSessionTarget,
        wakeMode: CronWakeMode,
        payload: CronPayload,
        delivery: CronDelivery?,
        state: CronJobState
    ) -> CronJob {
        let fixture = CronJobFixture(
            id: id,
            agentId: agentId,
            name: name,
            description: description,
            enabled: enabled,
            deleteAfterRun: deleteAfterRun,
            createdAtMs: createdAtMs,
            updatedAtMs: updatedAtMs,
            schedule: schedule,
            sessionTarget: sessionTarget.rawValue,
            wakeMode: wakeMode,
            payload: payload,
            delivery: delivery,
            state: state)

        do {
            let data = try JSONEncoder().encode(fixture)
            return try JSONDecoder().decode(CronJob.self, from: data)
        } catch {
            fatalError("Failed to build CronJob fixture: \(error)")
        }
    }

    private func makeEditor(job: CronJob? = nil, channelsStore: ChannelsStore? = nil) -> CronJobEditor {
        CronJobEditor(
            job: job,
            isSaving: .constant(false),
            error: .constant(nil),
            channelsStore: channelsStore ?? ChannelsStore(isPreview: true),
            onCancel: {},
            onSave: { _ in })
    }

    @Test func `status pill builds body`() {
        _ = StatusPill(text: "ok", tint: .green).body
        _ = StatusPill(text: "disabled", tint: .secondary).body
    }

    @Test func `cron job editor builds body for new job`() {
        let view = self.makeEditor()
        _ = view.body
    }

    @Test func `cron job editor builds body for existing job`() {
        let channelsStore = ChannelsStore(isPreview: true)
        let job = self.makeCronJob(
            id: "job-1",
            agentId: "ops",
            name: "Daily summary",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
            schedule: .every(everyMs: 3_600_000, anchorMs: 1_700_000_000_000),
            sessionTarget: .predefined(.isolated),
            wakeMode: .nextHeartbeat,
            payload: .agentTurn(
                message: "Summarize the last day",
                thinking: "low",
                timeoutSeconds: 120,
                deliver: nil,
                channel: nil,
                to: nil,
                bestEffortDeliver: nil),
            delivery: CronDelivery(mode: .announce, channel: "whatsapp", to: "+15551234567", bestEffort: true),
            state: CronJobState(
                nextRunAtMs: 1_700_000_100_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: "ok",
                lastError: nil,
                lastDurationMs: 1000))

        let view = self.makeEditor(job: job, channelsStore: channelsStore)
        _ = view.body
    }

    @Test func `cron job editor exercises builders`() {
        var view = self.makeEditor()
        view.exerciseForTesting()
    }

    @Test func `cron job editor includes delete after run for at schedule`() {
        let view = self.makeEditor()

        var root: [String: Any] = [:]
        view.applyDeleteAfterRun(to: &root, scheduleKind: CronJobEditor.ScheduleKind.at, deleteAfterRun: true)
        let raw = root["deleteAfterRun"] as? Bool
        #expect(raw == true)
    }
}
