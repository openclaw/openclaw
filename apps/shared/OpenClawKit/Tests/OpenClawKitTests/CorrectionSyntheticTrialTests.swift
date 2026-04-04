import Foundation
import Testing
@testable import OpenClawKit

@Suite(.serialized)
struct CorrectionSyntheticTrialTests {
    @Test
    func queuesSyntheticTrialBatchOnceThreeCandidateTemplatesExist() throws {
        try self.withTemporaryCasebookStore {
            try self.promoteThreeCandidateTemplates()

            let snapshot = CorrectionCasebookStore.load()
            let summary = snapshot.syntheticTrialSummary()
            let batch = try #require(snapshot.currentSyntheticTrialBatch())
            let nextRun = try #require(snapshot.nextSyntheticTrialRun())

            #expect(summary.stage == .staged)
            #expect(summary.candidateTemplateCount == 3)
            #expect(summary.plannedRunCount == 9)
            #expect(summary.completedRunCount == 0)
            #expect(summary.failedRunCount == 0)
            #expect(batch.runs.count == 9)
            #expect(batch.runs.allSatisfy { $0.result == .pending })
            #expect(batch.botProfile.label.isEmpty == false)
            #expect(batch.botProfile.retiredAtMs == nil)
            #expect(nextRun.templateID == "template-a")
            #expect(nextRun.iteration == 1)
            #expect(nextRun.syntheticBotLabel == batch.botProfile.label)
            #expect(nextRun.profileSummary.contains(batch.botProfile.label))
        }
    }

    @Test
    func recordsSyntheticTrialOutcomeAndPromotesUniversalTemplate() throws {
        try self.withTemporaryCasebookStore {
            try self.promoteThreeCandidateTemplates()

            let initial = CorrectionCasebookStore.load()
            let batch = try #require(initial.currentSyntheticTrialBatch())

            for iteration in 1...3 {
                _ = CorrectionCasebookStore.recordSyntheticTrialOutcome(
                    batchID: batch.id,
                    templateID: "template-a",
                    iteration: iteration,
                    result: .passed,
                    notes: "Run \(iteration) closed cleanly.",
                    recordedAt: Date(timeIntervalSince1970: Double(2_000 + iteration)))
            }

            let snapshot = CorrectionCasebookStore.load()
            let summary = snapshot.syntheticTrialSummary()
            let template = try #require(snapshot.syntheticTrialTemplate(templateID: "template-a"))
            let nextRun = try #require(snapshot.nextSyntheticTrialRun())

            #expect(template.stage == .universal)
            #expect(template.passedRunCount == 3)
            #expect(template.failedRunCount == 0)
            #expect(template.pendingRunCount == 0)
            #expect(summary.stage == .validating)
            #expect(summary.universalTemplateIDs == ["template-a"])
            #expect(summary.completedRunCount == 3)
            #expect(summary.passedRunCount == 3)
            #expect(nextRun.templateID == "template-b")
            #expect(nextRun.iteration == 1)
        }
    }

    @Test
    func decodesLegacyVersionOneSnapshotWithoutSyntheticTrials() throws {
        let legacy = """
        {
          "version": 1,
          "updatedAtMs": 123,
          "records": [],
          "activeCases": []
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CorrectionCasebookSnapshot.self, from: legacy)

        #expect(decoded.version == CorrectionCasebookSnapshot.currentVersion)
        #expect(decoded.syntheticTrials.isEmpty)
        #expect(decoded.records.isEmpty)
        #expect(decoded.activeCases.isEmpty)
    }

    private func promoteThreeCandidateTemplates() throws {
        let bots = ["bot:main", "bot:watchdog", "bot:triage"]
        let templates: [(id: String, label: String)] = [
            ("template-a", "Template A"),
            ("template-b", "Template B"),
            ("template-c", "Template C"),
        ]

        var time: TimeInterval = 1_000
        for template in templates {
            for bot in bots {
                let diagnosisID = "diagnosis-\(template.id)-\(bot.replacingOccurrences(of: ":", with: "-"))"
                let input = CorrectionCaseInput(
                    subjectID: bot,
                    subjectLabel: bot,
                    role: "bot",
                    diagnosisID: diagnosisID,
                    diagnosisLabel: diagnosisID,
                    severity: "warning",
                    summary: "The bot needs correction.",
                    evidence: ["No clean output yet"],
                    prescriptionLine: "Apply \(template.label).",
                    remedyTemplateID: template.id,
                    remedyTemplateLabel: template.label,
                    likelyRootCause: "The lane drifted away from verified delivery.",
                    fingerprint: "\(template.id)-\(bot)-\(time)")
                _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: Date(timeIntervalSince1970: time))
                _ = CorrectionCasebookStore.recordOutcome(
                    subjectID: bot,
                    diagnosisID: diagnosisID,
                    outcome: .resolved,
                    recordedAt: Date(timeIntervalSince1970: time + 1))
                time += 10
            }
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
