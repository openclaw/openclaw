import Foundation
import Testing
@testable import OpenClawKit

@Suite(.serialized)
struct CorrectionCasebookStoreTests {
    @Test
    func repeatedFingerprintDoesNotCreateDuplicateOccurrence() throws {
        try self.withTemporaryCasebookStore {
            let input = CorrectionCaseInput(
                subjectID: "main-seat",
                subjectLabel: "Main seat",
                role: "main",
                diagnosisID: "critical_stall",
                diagnosisLabel: "Critical stall",
                severity: "warning",
                summary: "The main seat has been correcting for more than five minutes.",
                evidence: ["Started 7 minutes ago"],
                prescriptionLine: "Shrink scope and ship one verified output.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One",
                likelyRootCause: "Discussion replaced delivery.",
                fingerprint: "stall:started=1")

            _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: Date(timeIntervalSince1970: 100))
            _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: Date(timeIntervalSince1970: 110))

            let snapshot = CorrectionCasebookStore.load()
            let record = try #require(snapshot.record(subjectID: "main-seat"))
            let condition = try #require(record.condition(diagnosisID: "critical_stall"))

            #expect(condition.occurrenceCount == 1)
            #expect(condition.successCount == 0)
            #expect(condition.failureCount == 0)
            #expect(record.observations.count == 1)
            #expect(record.treatments.count == 1)
            #expect(snapshot.activeCases.count == 1)
        }
    }

    @Test
    func fingerprintChangeFailsCurrentTreatmentAndResolutionClosesLoop() throws {
        try self.withTemporaryCasebookStore {
            let first = CorrectionCaseInput(
                subjectID: "main-seat",
                subjectLabel: "Main seat",
                role: "main",
                diagnosisID: "critical_stall",
                diagnosisLabel: "Critical stall",
                severity: "warning",
                summary: "The main seat has been correcting for more than five minutes.",
                evidence: ["Started 7 minutes ago"],
                prescriptionLine: "Shrink scope and ship one verified output.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One",
                likelyRootCause: "Discussion replaced delivery.",
                fingerprint: "stall:started=1")
            let second = CorrectionCaseInput(
                subjectID: "main-seat",
                subjectLabel: "Main seat",
                role: "main",
                diagnosisID: "critical_stall",
                diagnosisLabel: "Critical stall",
                severity: "critical",
                summary: "The main seat is still stalled and the artifact has not moved.",
                evidence: ["Started 11 minutes ago", "No new artifact"],
                prescriptionLine: "Freeze discussion and post one fresh artifact.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One",
                likelyRootCause: "The seat stayed in narration mode.",
                fingerprint: "stall:started=2")

            _ = CorrectionCasebookStore.syncActiveCases([first], observedAt: Date(timeIntervalSince1970: 200))
            _ = CorrectionCasebookStore.syncActiveCases([second], observedAt: Date(timeIntervalSince1970: 210))
            _ = CorrectionCasebookStore.syncActiveCases([], observedAt: Date(timeIntervalSince1970: 220))

            let snapshot = CorrectionCasebookStore.load()
            let record = try #require(snapshot.record(subjectID: "main-seat"))
            let condition = try #require(record.condition(diagnosisID: "critical_stall"))
            let latestTreatment = try #require(record.latestTreatment(diagnosisID: "critical_stall"))
            let template = try #require(record.templates.first { $0.templateID == "ship_one_verified_output" })

            #expect(condition.occurrenceCount == 1)
            #expect(condition.failureCount == 1)
            #expect(condition.successCount == 1)
            #expect(condition.lastOutcome == .resolved)
            #expect(record.observations.count == 2)
            #expect(record.treatments.count == 2)
            #expect(latestTreatment.result == .resolved)
            #expect(template.prescribedCount == 2)
            #expect(template.failureCount == 1)
            #expect(template.successCount == 1)
            #expect(snapshot.activeCases.isEmpty)
        }
    }

    @Test
    func manualOutcomeClosesActiveCaseAndUpdatesTreatmentStats() throws {
        try self.withTemporaryCasebookStore {
            let input = CorrectionCaseInput(
                subjectID: "watchdog-seat",
                subjectLabel: "Watchdog seat",
                role: "support",
                diagnosisID: "evidence_stale",
                diagnosisLabel: "Evidence stale",
                severity: "warning",
                summary: "The evidence chain has not produced a fresh artifact.",
                evidence: ["No verified output in 6 minutes"],
                prescriptionLine: "Post one verified artifact with proof.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One",
                likelyRootCause: "The lane is narrating instead of shipping.",
                fingerprint: "evidence:stale=1")

            _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: Date(timeIntervalSince1970: 300))
            _ = CorrectionCasebookStore.recordOutcome(
                subjectID: "watchdog-seat",
                diagnosisID: "evidence_stale",
                outcome: .resolved,
                recordedAt: Date(timeIntervalSince1970: 305))

            let snapshot = CorrectionCasebookStore.load()
            let record = try #require(snapshot.record(subjectID: "watchdog-seat"))
            let condition = try #require(record.condition(diagnosisID: "evidence_stale"))
            let latestTreatment = try #require(record.latestTreatment(diagnosisID: "evidence_stale"))
            let template = try #require(record.templates.first { $0.templateID == "ship_one_verified_output" })

            #expect(snapshot.activeCases.isEmpty)
            #expect(condition.occurrenceCount == 1)
            #expect(condition.successCount == 1)
            #expect(condition.failureCount == 0)
            #expect(condition.lastOutcome == .resolved)
            #expect(latestTreatment.result == .resolved)
            #expect(latestTreatment.resolvedAtMs == 305_000)
            #expect(template.prescribedCount == 1)
            #expect(template.successCount == 1)
            #expect(template.failureCount == 0)
        }
    }

    @Test
    func manualFailureKeepsRecordAndCountsTemplateFailure() throws {
        try self.withTemporaryCasebookStore {
            let input = CorrectionCaseInput(
                subjectID: "main-seat",
                subjectLabel: "Main seat",
                role: "main",
                diagnosisID: "control_channel_degraded",
                diagnosisLabel: "Control channel degraded",
                severity: "critical",
                summary: "Control evidence is degraded.",
                evidence: ["Transport quality is unstable"],
                prescriptionLine: "Stabilize the control lane before retrying.",
                remedyTemplateID: "stabilize_control_lane",
                remedyTemplateLabel: "Stabilize Control Lane",
                likelyRootCause: "The supervision transport is unstable.",
                fingerprint: "control:degraded=1")

            _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: Date(timeIntervalSince1970: 400))
            _ = CorrectionCasebookStore.recordOutcome(
                subjectID: "main-seat",
                diagnosisID: "control_channel_degraded",
                outcome: .failed,
                recordedAt: Date(timeIntervalSince1970: 410))

            let snapshot = CorrectionCasebookStore.load()
            let record = try #require(snapshot.record(subjectID: "main-seat"))
            let condition = try #require(record.condition(diagnosisID: "control_channel_degraded"))
            let latestTreatment = try #require(record.latestTreatment(diagnosisID: "control_channel_degraded"))
            let template = try #require(record.templates.first { $0.templateID == "stabilize_control_lane" })

            #expect(snapshot.activeCases.isEmpty)
            #expect(condition.successCount == 0)
            #expect(condition.failureCount == 1)
            #expect(condition.lastOutcome == .failed)
            #expect(latestTreatment.result == .failed)
            #expect(template.successCount == 0)
            #expect(template.failureCount == 1)
        }
    }

    @Test
    func runtimeEvidencePersistsAcrossSameFingerprintSyncs() throws {
        try self.withTemporaryCasebookStore {
            let firstEvidence = CorrectionRuntimeEvidence(
                assistantOutputAtMs: 500_000,
                assistantOutputSummary: "Posted first artifact draft",
                assistantOutputHasArtifact: true,
                outputAfterRoundStart: true)
            let refreshedEvidence = CorrectionRuntimeEvidence(
                assistantOutputAtMs: 510_000,
                assistantOutputSummary: "Posted revised artifact draft with fixes",
                assistantOutputHasArtifact: true,
                outputAfterRoundStart: true)

            let first = CorrectionCaseInput(
                subjectID: "gaga-seat",
                subjectLabel: "Gaga seat",
                role: "design",
                diagnosisID: "correction_stall_over_5m",
                diagnosisLabel: "Correction stall over 5m",
                severity: "warning",
                summary: "The design lane is stalling.",
                evidence: ["Started 7 minutes ago"],
                prescriptionLine: "Ship one verified output.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One",
                likelyRootCause: "The lane is still discussing.",
                runtimeEvidence: firstEvidence,
                fingerprint: "design-stall-1")
            let refreshed = CorrectionCaseInput(
                subjectID: "gaga-seat",
                subjectLabel: "Gaga seat",
                role: "design",
                diagnosisID: "correction_stall_over_5m",
                diagnosisLabel: "Correction stall over 5m",
                severity: "warning",
                summary: "The design lane is still open but now has fresh output.",
                evidence: ["Started 8 minutes ago", "Fresh artifact posted"],
                prescriptionLine: "Ship one verified output.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One",
                likelyRootCause: "The lane is not closing the loop.",
                runtimeEvidence: refreshedEvidence,
                fingerprint: "design-stall-1")
            let replayWithoutLiveWindow = CorrectionCaseInput(
                subjectID: "gaga-seat",
                subjectLabel: "Gaga seat",
                role: "design",
                diagnosisID: "correction_stall_over_5m",
                diagnosisLabel: "Correction stall over 5m",
                severity: "warning",
                summary: "The design lane still needs closure.",
                evidence: ["Started 9 minutes ago"],
                prescriptionLine: "Ship one verified output.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One",
                likelyRootCause: "The lane is not closing the loop.",
                runtimeEvidence: nil,
                fingerprint: "design-stall-1")

            _ = CorrectionCasebookStore.syncActiveCases([first], observedAt: Date(timeIntervalSince1970: 500))
            _ = CorrectionCasebookStore.syncActiveCases([refreshed], observedAt: Date(timeIntervalSince1970: 510))
            _ = CorrectionCasebookStore.syncActiveCases([replayWithoutLiveWindow], observedAt: Date(timeIntervalSince1970: 520))

            let snapshot = CorrectionCasebookStore.load()
            let active = try #require(snapshot.activeCases.first)
            let record = try #require(snapshot.record(subjectID: "gaga-seat"))
            let latestTreatment = try #require(record.latestTreatment(diagnosisID: "correction_stall_over_5m"))
            let observation = try #require(record.observations.last)

            #expect(record.observations.count == 1)
            #expect(active.runtimeEvidence?.assistantOutputSummary == "Posted revised artifact draft with fixes")
            #expect(latestTreatment.runtimeEvidence?.assistantOutputAtMs == 510_000)
            #expect(latestTreatment.runtimeEvidence?.assistantOutputHasArtifact == true)
            #expect(observation.runtimeEvidence?.assistantOutputSummary == "Posted revised artifact draft with fixes")
            #expect(observation.observedAtMs == 520_000)
        }
    }

    @Test
    func interventionDispatchPersistsOnActiveCaseAndPendingTreatment() throws {
        try self.withTemporaryCasebookStore {
            let input = CorrectionCaseInput(
                subjectID: "watchdog-seat",
                subjectLabel: "Watchdog seat",
                role: "support",
                diagnosisID: "correction_stall_over_5m",
                diagnosisLabel: "Correction stall over 5m",
                severity: "warning",
                summary: "The lane is still correcting.",
                evidence: ["No verified output in 6 minutes"],
                prescriptionLine: "Ship one verified output with evidence.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One Verified Output",
                likelyRootCause: "The lane is narrating instead of shipping.",
                fingerprint: "watchdog-stall-1")
            let refreshed = CorrectionCaseInput(
                subjectID: "watchdog-seat",
                subjectLabel: "Watchdog seat",
                role: "support",
                diagnosisID: "correction_stall_over_5m",
                diagnosisLabel: "Correction stall over 5m",
                severity: "warning",
                summary: "Fresh output appeared after dispatch.",
                evidence: ["A fresh assistant output landed"],
                prescriptionLine: "Ship one verified output with evidence.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One Verified Output",
                likelyRootCause: "The lane is still narrating instead of shipping.",
                runtimeEvidence: CorrectionRuntimeEvidence(
                    assistantOutputAtMs: 610_000,
                    assistantOutputSummary: "Posted a concrete artifact summary",
                    assistantOutputHasArtifact: true,
                    outputAfterRoundStart: true),
                fingerprint: "watchdog-stall-1")

            _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: Date(timeIntervalSince1970: 600))
            _ = CorrectionCasebookStore.recordInterventionDispatch(
                subjectID: "watchdog-seat",
                diagnosisID: "correction_stall_over_5m",
                summary: "Ship One Verified Output: Ship one verified output with evidence.",
                recordedAt: Date(timeIntervalSince1970: 605))
            _ = CorrectionCasebookStore.syncActiveCases([refreshed], observedAt: Date(timeIntervalSince1970: 610))

            let snapshot = CorrectionCasebookStore.load()
            let active = try #require(snapshot.activeCases.first)
            let record = try #require(snapshot.record(subjectID: "watchdog-seat"))
            let latestTreatment = try #require(record.latestTreatment(diagnosisID: "correction_stall_over_5m"))

            #expect(active.runtimeEvidence?.interventionDispatchedAtMs == 605_000)
            #expect(active.runtimeEvidence?.interventionDispatchSummary == "Ship One Verified Output: Ship one verified output with evidence.")
            #expect(active.runtimeEvidence?.assistantOutputAtMs == 610_000)
            #expect(latestTreatment.runtimeEvidence?.interventionDispatchedAtMs == 605_000)
            #expect(latestTreatment.runtimeEvidence?.interventionDispatchSummary == "Ship One Verified Output: Ship one verified output with evidence.")
            #expect(latestTreatment.runtimeEvidence?.assistantOutputHasArtifact == true)
        }
    }

    @Test
    func externalResearchPersistsOnActiveCaseAndPendingTreatment() throws {
        try self.withTemporaryCasebookStore {
            let input = CorrectionCaseInput(
                subjectID: "watchdog-seat",
                subjectLabel: "Watchdog seat",
                role: "support",
                diagnosisID: "correction_stall_over_5m",
                diagnosisLabel: "Correction stall over 5m",
                severity: "warning",
                summary: "The lane is still correcting without a verified output.",
                evidence: ["No verified output in 6 minutes"],
                prescriptionLine: "Ship one verified output with evidence.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One Verified Output",
                likelyRootCause: "The lane is narrating instead of shipping.",
                fingerprint: "watchdog-research-1")
            let refreshed = CorrectionCaseInput(
                subjectID: "watchdog-seat",
                subjectLabel: "Watchdog seat",
                role: "support",
                diagnosisID: "correction_stall_over_5m",
                diagnosisLabel: "Correction stall over 5m",
                severity: "warning",
                summary: "Fresh output appeared after research.",
                evidence: ["A fresh assistant output landed"],
                prescriptionLine: "Ship one verified output with evidence.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One Verified Output",
                likelyRootCause: "The lane is still narrating instead of shipping.",
                runtimeEvidence: CorrectionRuntimeEvidence(
                    assistantOutputAtMs: 710_000,
                    assistantOutputSummary: "Posted a concrete artifact summary",
                    assistantOutputHasArtifact: true,
                    outputAfterRoundStart: true),
                fingerprint: "watchdog-research-1")

            _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: Date(timeIntervalSince1970: 700))
            _ = CorrectionCasebookStore.recordExternalResearch(
                subjectID: "watchdog-seat",
                diagnosisID: "correction_stall_over_5m",
                query: "llm agent stalled no output verified artifact",
                summary: "Captured 2 public references for the current symptom cluster.",
                items: [
                    CorrectionExternalResearchItem(
                        title: "A Case of Artificial Intelligence Chatbot Hallucination",
                        url: "https://pubmed.ncbi.nlm.nih.gov/38635259/",
                        source: "pubmed.ncbi.nlm.nih.gov",
                        snippet: "LLMs can generate hallucinations and inaccurate information."),
                    CorrectionExternalResearchItem(
                        title: "A Call to Address AI Hallucinations",
                        url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC10552880/",
                        source: "pmc.ncbi.nlm.nih.gov",
                        snippet: "Healthcare teams should document and mitigate hallucination risks.")
                ],
                recordedAt: Date(timeIntervalSince1970: 705))
            _ = CorrectionCasebookStore.syncActiveCases([refreshed], observedAt: Date(timeIntervalSince1970: 710))

            let snapshot = CorrectionCasebookStore.load()
            let active = try #require(snapshot.activeCases.first)
            let record = try #require(snapshot.record(subjectID: "watchdog-seat"))
            let latestTreatment = try #require(record.latestTreatment(diagnosisID: "correction_stall_over_5m"))

            #expect(active.runtimeEvidence?.externalResearchFetchedAtMs == 705_000)
            #expect(active.runtimeEvidence?.externalResearchQuery == "llm agent stalled no output verified artifact")
            #expect(active.runtimeEvidence?.externalResearchSummary == "Captured 2 public references for the current symptom cluster.")
            #expect(active.runtimeEvidence?.externalResearchItems.count == 2)
            #expect(active.runtimeEvidence?.assistantOutputAtMs == 710_000)
            #expect(latestTreatment.runtimeEvidence?.externalResearchFetchedAtMs == 705_000)
            #expect(latestTreatment.runtimeEvidence?.externalResearchItems.first?.source == "pubmed.ncbi.nlm.nih.gov")
            #expect(latestTreatment.runtimeEvidence?.assistantOutputHasArtifact == true)
        }
    }

    private func withTemporaryCasebookStore(_ body: () throws -> Void) throws {
        let temporaryRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryRoot, withIntermediateDirectories: true)
        let previous = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", temporaryRoot.path, 1)
        defer {
            if let previous {
                setenv("OPENCLAW_STATE_DIR", previous, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: temporaryRoot)
        }
        try body()
    }
}
