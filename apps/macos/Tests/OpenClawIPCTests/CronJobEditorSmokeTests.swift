import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CronJobEditorSmokeTests {
    @Test func statusPillBuildsBody() {
        _ = StatusPill(text: "ok", tint: .green).body
        _ = StatusPill(text: "disabled", tint: .secondary).body
    }

    @Test func cronJobEditorBuildsBodyForNewJob() {
        let channelsStore = ChannelsStore(isPreview: true)
        let view = CronJobEditor(
            job: nil,
            isSaving: .constant(false),
            error: .constant(nil),
            channelsStore: channelsStore,
            onCancel: {},
            onSave: { _ in })
        _ = view.body
    }

    @Test func cronJobEditorBuildsBodyForExistingJob() {
        let channelsStore = ChannelsStore(isPreview: true)
        let job = CronJob(
            id: "job-1",
            agentId: "ops",
            name: "Daily summary",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
            schedule: .every(everyMs: 3_600_000, anchorMs: 1_700_000_000_000),
            sessionTarget: .isolated,
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

        let view = CronJobEditor(
            job: job,
            isSaving: .constant(false),
            error: .constant(nil),
            channelsStore: channelsStore,
            onCancel: {},
            onSave: { _ in })
        _ = view.body
    }

    @Test func cronJobEditorExercisesBuilders() {
        let channelsStore = ChannelsStore(isPreview: true)
        var view = CronJobEditor(
            job: nil,
            isSaving: .constant(false),
            error: .constant(nil),
            channelsStore: channelsStore,
            onCancel: {},
            onSave: { _ in })
        view.exerciseForTesting()
    }

    @Test func cronJobEditorIncludesDeleteAfterRunForAtSchedule() throws {
        let channelsStore = ChannelsStore(isPreview: true)
        let view = CronJobEditor(
            job: nil,
            isSaving: .constant(false),
            error: .constant(nil),
            channelsStore: channelsStore,
            onCancel: {},
            onSave: { _ in })

        var root: [String: Any] = [:]
        view.applyDeleteAfterRun(to: &root, scheduleKind: CronJobEditor.ScheduleKind.at, deleteAfterRun: true)
        let raw = root["deleteAfterRun"] as? Bool
        #expect(raw == true)
    }

    @Test func cronJobEditorPreservesWebhookDeliveryWhenHydratingExistingJob() {
        let channelsStore = ChannelsStore(isPreview: true)
        let job = CronJob(
            id: "job-2",
            agentId: nil,
            name: "Webhook main",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
            schedule: .every(everyMs: 3_600_000, anchorMs: 1_700_000_000_000),
            sessionTarget: .main,
            wakeMode: .nextHeartbeat,
            payload: .systemEvent(text: "notify"),
            delivery: CronDelivery(mode: .webhook, channel: nil, to: "https://example.invalid/cron", bestEffort: nil),
            state: CronJobState(
                nextRunAtMs: nil,
                runningAtMs: nil,
                lastRunAtMs: nil,
                lastStatus: nil,
                lastError: nil,
                lastDurationMs: nil))

        var view = CronJobEditor(
            job: job,
            isSaving: .constant(false),
            error: .constant(nil),
            channelsStore: channelsStore,
            onCancel: {},
            onSave: { _ in })
        view.hydrateFromJob()

        #expect(view.deliveryMode == .webhook)
        #expect(view.to == "https://example.invalid/cron")
    }

    @Test func cronJobEditorIncludesWebhookDeliveryForMainJobs() throws {
        let channelsStore = ChannelsStore(isPreview: true)
        var view = CronJobEditor(
            job: nil,
            isSaving: .constant(false),
            error: .constant(nil),
            channelsStore: channelsStore,
            onCancel: {},
            onSave: { _ in })
        view.name = "Webhook main"
        view.sessionTarget = .main
        view.payloadKind = .systemEvent
        view.systemEventText = "notify"
        view.deliveryMode = .webhook
        view.to = "https://example.invalid/cron"

        let payload = try view.buildPayload()
        let delivery = payload["delivery"]?.value as? [String: Any]
        #expect(delivery?["mode"] as? String == "webhook")
        #expect(delivery?["to"] as? String == "https://example.invalid/cron")
    }
}
