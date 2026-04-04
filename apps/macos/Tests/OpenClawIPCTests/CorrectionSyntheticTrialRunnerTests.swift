import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct CorrectionSyntheticTrialRunnerTests {
    @Test
    func derivesContextFromLatestTemplateEvidence() throws {
        let snapshot = CorrectionCasebookSnapshot(
            records: [
                BotMedicalRecord(
                    subjectID: "bot:watchdog",
                    label: "Watchdog",
                    role: "bot",
                    createdAtMs: 1_000,
                    updatedAtMs: 4_000,
                    observations: [
                        CorrectionObservation(
                            id: "obs-1",
                            observedAtMs: 4_000,
                            diagnosisID: "stalling",
                            diagnosisLabel: "Stalled correction loop",
                            severity: "critical",
                            summary: "No new output after correction.",
                            evidence: [
                                "Bot kept repeating the old diagnosis.",
                                "No artifact landed after the intervention.",
                            ],
                            prescriptionLine: "Ship one verified output with concrete evidence.",
                            remedyTemplateID: "ship_verified_output",
                            remedyTemplateLabel: "Ship Verified Output",
                            likelyRootCause: "The bot is optimizing for status chatter instead of delivery.",
                            runtimeEvidence: CorrectionRuntimeEvidence(
                                assistantOutputAtMs: 3_950,
                                assistantOutputSummary: "Still talking about progress instead of shipping.",
                                assistantOutputHasArtifact: false,
                                outputAfterRoundStart: true),
                            fingerprint: "fp-1"),
                    ],
                    templates: [
                        CorrectionTemplateStats(
                            templateID: "ship_verified_output",
                            templateLabel: "Ship Verified Output",
                            prescribedCount: 3,
                            successCount: 3,
                            failureCount: 0,
                            lastUsedAtMs: 4_000),
                    ],
                    treatments: [
                        CorrectionTreatmentRecord(
                            id: "treat-1",
                            diagnosisID: "stalling",
                            diagnosisLabel: "Stalled correction loop",
                            remedyTemplateID: "ship_verified_output",
                            remedyTemplateLabel: "Ship Verified Output",
                            prescribedAtMs: 4_000,
                            resolvedAtMs: 4_200,
                            result: .resolved,
                            prescriptionLine: "Ship one verified output with concrete evidence.",
                            likelyRootCause: "The bot is optimizing for status chatter instead of delivery.",
                            runtimeEvidence: CorrectionRuntimeEvidence(
                                assistantOutputAtMs: 4_100,
                                assistantOutputSummary: "Explained intent but still missed the deliverable.",
                                assistantOutputHasArtifact: false,
                                outputAfterRoundStart: true),
                            fingerprint: "fp-1"),
                    ]),
                BotMedicalRecord(
                    subjectID: "bot:triage",
                    label: "Triage",
                    role: "bot",
                    createdAtMs: 900,
                    updatedAtMs: 3_500,
                    templates: [
                        CorrectionTemplateStats(
                            templateID: "ship_verified_output",
                            templateLabel: "Ship Verified Output",
                            prescribedCount: 1,
                            successCount: 1,
                            failureCount: 0,
                            lastUsedAtMs: 3_500),
                    ],
                    treatments: [
                        CorrectionTreatmentRecord(
                            id: "treat-2",
                            diagnosisID: "stalling",
                            diagnosisLabel: "Stalled correction loop",
                            remedyTemplateID: "ship_verified_output",
                            remedyTemplateLabel: "Ship Verified Output",
                            prescribedAtMs: 3_500,
                            resolvedAtMs: 3_650,
                            result: .resolved,
                            prescriptionLine: "Ship one verified output with concrete evidence.",
                            likelyRootCause: "The bot kept narrating instead of acting.",
                            fingerprint: "fp-2"),
                    ]),
            ],
            activeCases: [
                CorrectionActiveCase(
                    key: "bot:watchdog|stalling",
                    subjectID: "bot:watchdog",
                    diagnosisID: "stalling",
                    diagnosisLabel: "Stalled correction loop",
                    fingerprint: "active-1",
                    firstSeenAtMs: 4_000,
                    lastSeenAtMs: 4_050,
                    treatmentRecordID: "treat-1",
                    prescriptionLine: "Ship one verified output with concrete evidence.",
                    remedyTemplateID: "ship_verified_output",
                    remedyTemplateLabel: "Ship Verified Output",
                    runtimeEvidence: CorrectionRuntimeEvidence(
                        assistantOutputAtMs: 4_060,
                        assistantOutputSummary: "Still narrating the same blocker.",
                        assistantOutputHasArtifact: false,
                        outputAfterRoundStart: true)),
            ])

        let context = try #require(
            CorrectionSyntheticTrialRunner.context(
                templateID: "ship_verified_output",
                casebook: snapshot))

        #expect(context.templateLabel == "Ship Verified Output")
        #expect(context.diagnosisLabel == "Stalled correction loop")
        #expect(context.prescriptionLine == "Ship one verified output with concrete evidence.")
        #expect(context.likelyRootCause == "The bot is optimizing for status chatter instead of delivery.")
        #expect(Set(context.successfulBotLabels) == Set(["Watchdog", "Triage"]))
        #expect(context.evidence.count == 4)
        #expect(context.evidence.contains("Bot kept repeating the old diagnosis."))
    }

    @Test
    func passesSpecificEvidenceGroundedReply() throws {
        let context = CorrectionSyntheticTrialRunner.Context(
            templateID: "ship_verified_output",
            templateLabel: "Ship Verified Output",
            diagnosisLabel: "Stalled correction loop",
            prescriptionLine: "Ship one verified output with concrete evidence.",
            likelyRootCause: "The bot is optimizing for status chatter instead of delivery.",
            evidence: [
                "Bot kept repeating the old diagnosis.",
                "No artifact landed after the intervention.",
                "Latest runtime output: Explained intent but still missed the deliverable.",
            ],
            successfulBotLabels: ["Watchdog", "Triage"],
            failedBotLabels: [],
            successCount: 4,
            failureCount: 0)

        let assessment = CorrectionSyntheticTrialRunner.evaluate(
            responseText: """
            Failure mode: this is still a stalled correction loop caused by status chatter instead of delivery.
            I will apply Ship Verified Output by checking the old diagnosis against the runtime log, patching the response so it cites the missing artifact, and shipping one verified output instead of another status note.
            Next checkpoint: deliver a concrete artifact summary with the evidence lines and verify the new output lands after the intervention.
            """,
            context: context)

        #expect(assessment.result == .passed)
        #expect(assessment.diagnosisMatched)
        #expect(assessment.evidenceMatched >= 2)
        #expect(assessment.hasCheckpoint)
        #expect(assessment.strongNegativeSignal == false)
    }

    @Test
    func failsGenericStallingReply() throws {
        let context = CorrectionSyntheticTrialRunner.Context(
            templateID: "ship_verified_output",
            templateLabel: "Ship Verified Output",
            diagnosisLabel: "Stalled correction loop",
            prescriptionLine: "Ship one verified output with concrete evidence.",
            likelyRootCause: "The bot is optimizing for status chatter instead of delivery.",
            evidence: [
                "Bot kept repeating the old diagnosis.",
                "No artifact landed after the intervention.",
            ],
            successfulBotLabels: ["Watchdog"],
            failedBotLabels: [],
            successCount: 3,
            failureCount: 0)

        let assessment = CorrectionSyntheticTrialRunner.evaluate(
            responseText: """
            I need more context before I can help. Let me know what happened and I can take a look later.
            """,
            context: context)

        #expect(assessment.result == .failed)
        #expect(assessment.strongNegativeSignal)
        #expect(assessment.hasCheckpoint == false)
    }

    @Test
    func queueProgressLineIncludesNextPlan() {
        let progress = CorrectionSyntheticTrialRunner.BatchProgress(
            plannedRunCount: 6,
            completedRunCount: 2,
            passedRunCount: 2,
            failedRunCount: 0)
        let plan = CorrectionSyntheticTrialExecutionPlan(
            batchID: "batch-1",
            templateID: "template-a",
            templateLabel: "Template A",
            iteration: 3,
            syntheticBotID: "synthetic-bot-1",
            syntheticBotLabel: "Synthetic Harbor",
            persona: "fast but distractible execution bot",
            specialty: "ops",
            temperament: "restless")

        let line = CorrectionSyntheticTrialRunner.queueProgressLine(progress: progress, currentPlan: plan)

        #expect(line.contains("2/6 synthetic validation run(s) complete"))
        #expect(line.contains("Template A round 3"))
        #expect(line.contains("Synthetic Harbor"))
    }

    @Test
    func pendingRunCountOnlyCountsPendingRuns() {
        let snapshot = CorrectionCasebookSnapshot(
            syntheticTrials: [
                CorrectionSyntheticTrialBatch(
                    id: "batch-1",
                    createdAtMs: 1_000,
                    candidateTemplateIDs: ["template-a"],
                    botProfile: CorrectionSyntheticBotProfile(
                        id: "synthetic-bot-1",
                        label: "Synthetic Harbor",
                        persona: "fast but distractible execution bot",
                        specialty: "ops",
                        temperament: "restless",
                        createdAtMs: 1_000),
                    runs: [
                        CorrectionSyntheticTrialRun(
                            id: "run-1",
                            templateID: "template-a",
                            templateLabel: "Template A",
                            iteration: 1,
                            result: .passed,
                            scheduledAtMs: 1_000,
                            completedAtMs: 1_010),
                        CorrectionSyntheticTrialRun(
                            id: "run-2",
                            templateID: "template-a",
                            templateLabel: "Template A",
                            iteration: 2,
                            result: .pending,
                            scheduledAtMs: 1_020),
                        CorrectionSyntheticTrialRun(
                            id: "run-3",
                            templateID: "template-a",
                            templateLabel: "Template A",
                            iteration: 3,
                            result: .pending,
                            scheduledAtMs: 1_030),
                    ]),
            ])

        #expect(CorrectionSyntheticTrialRunner.pendingRunCount(casebook: snapshot) == 2)
    }
}
