import Foundation
import Testing
@testable import OpenClawKit

@Suite(.serialized)
struct CorrectionDiagnosisPortfolioTests {
    @Test
    func aggregatesCrossBotDiagnosisPrecedent() throws {
        try self.withTemporaryCasebookStore {
            let rounds: [(subjectID: String, time: TimeInterval)] = [
                ("bot:main", 1_000),
                ("bot:watchdog", 1_010),
            ]

            for (subjectID, time) in rounds {
                let input = CorrectionCaseInput(
                    subjectID: subjectID,
                    subjectLabel: subjectID,
                    role: "bot",
                    diagnosisID: "correction_stall_over_5m",
                    diagnosisLabel: "Correction stall over 5m",
                    severity: "warning",
                    summary: "The bot is stalled.",
                    evidence: ["No fresh verified output"],
                    prescriptionLine: "Ship one verified output.",
                    remedyTemplateID: "ship_one_verified_output",
                    remedyTemplateLabel: "Ship One Verified Output",
                    likelyRootCause: "The lane is narrating instead of shipping.",
                    fingerprint: "stall-\(subjectID)")
                _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: Date(timeIntervalSince1970: time))
                _ = CorrectionCasebookStore.recordOutcome(
                    subjectID: subjectID,
                    diagnosisID: "correction_stall_over_5m",
                    outcome: .resolved,
                    recordedAt: Date(timeIntervalSince1970: time + 1))
            }

            let snapshot = CorrectionCasebookStore.load()
            let portfolio = try #require(snapshot.diagnosisPortfolio(diagnosisID: "correction_stall_over_5m"))
            let recommendation = try #require(portfolio.topRecommendation)

            #expect(portfolio.seenBotCount == 2)
            #expect(portfolio.activeBotCount == 0)
            #expect(portfolio.occurrenceCount == 2)
            #expect(portfolio.resolvedCount == 2)
            #expect(portfolio.failedCount == 0)
            #expect(portfolio.leadingRootCauses.first == "The lane is narrating instead of shipping.")
            #expect(recommendation.templateID == "ship_one_verified_output")
            #expect(recommendation.stage == .recommended)
            #expect(recommendation.successCount == 2)
            #expect(recommendation.failureCount == 0)
            #expect(recommendation.successfulBotCount == 2)
        }
    }

    @Test
    func prefersCleanRecommendationOverMixedHistory() throws {
        try self.withTemporaryCasebookStore {
            let cleanRounds: [(subjectID: String, time: TimeInterval)] = [
                ("bot:main", 2_000),
                ("bot:watchdog", 2_010),
            ]
            for (subjectID, time) in cleanRounds {
                let input = CorrectionCaseInput(
                    subjectID: subjectID,
                    subjectLabel: subjectID,
                    role: "bot",
                    diagnosisID: "delivery_quality_drift",
                    diagnosisLabel: "Delivery quality drift",
                    severity: "warning",
                    summary: "The bot is drifting.",
                    evidence: ["Output is weak"],
                    prescriptionLine: "Ship one verified revision.",
                    remedyTemplateID: "ship_verified_revision",
                    remedyTemplateLabel: "Ship Verified Revision",
                    likelyRootCause: "The lane is polishing instead of closing.",
                    fingerprint: "clean-\(subjectID)")
                _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: Date(timeIntervalSince1970: time))
                _ = CorrectionCasebookStore.recordOutcome(
                    subjectID: subjectID,
                    diagnosisID: "delivery_quality_drift",
                    outcome: .resolved,
                    recordedAt: Date(timeIntervalSince1970: time + 1))
            }

            let mixedSuccess = CorrectionCaseInput(
                subjectID: "bot:triage",
                subjectLabel: "bot:triage",
                role: "bot",
                diagnosisID: "delivery_quality_drift",
                diagnosisLabel: "Delivery quality drift",
                severity: "warning",
                summary: "The bot is drifting.",
                evidence: ["Output is weak"],
                prescriptionLine: "Restart the reasoning chain.",
                remedyTemplateID: "restart_reasoning_chain",
                remedyTemplateLabel: "Restart Reasoning Chain",
                likelyRootCause: "The lane is patching the wrong layer.",
                fingerprint: "mixed-success")
            _ = CorrectionCasebookStore.syncActiveCases([mixedSuccess], observedAt: Date(timeIntervalSince1970: 2_020))
            _ = CorrectionCasebookStore.recordOutcome(
                subjectID: "bot:triage",
                diagnosisID: "delivery_quality_drift",
                outcome: .resolved,
                recordedAt: Date(timeIntervalSince1970: 2_021))

            let mixedFailure = CorrectionCaseInput(
                subjectID: "bot:review",
                subjectLabel: "bot:review",
                role: "bot",
                diagnosisID: "delivery_quality_drift",
                diagnosisLabel: "Delivery quality drift",
                severity: "critical",
                summary: "The bot is still drifting.",
                evidence: ["Weak output repeated"],
                prescriptionLine: "Restart the reasoning chain.",
                remedyTemplateID: "restart_reasoning_chain",
                remedyTemplateLabel: "Restart Reasoning Chain",
                likelyRootCause: "The lane is patching the wrong layer.",
                fingerprint: "mixed-failure")
            _ = CorrectionCasebookStore.syncActiveCases([mixedFailure], observedAt: Date(timeIntervalSince1970: 2_030))
            _ = CorrectionCasebookStore.recordOutcome(
                subjectID: "bot:review",
                diagnosisID: "delivery_quality_drift",
                outcome: .failed,
                recordedAt: Date(timeIntervalSince1970: 2_031))

            let snapshot = CorrectionCasebookStore.load()
            let portfolio = try #require(snapshot.diagnosisPortfolio(diagnosisID: "delivery_quality_drift"))

            #expect(portfolio.templateRecommendations.count == 2)
            #expect(portfolio.templateRecommendations[0].templateID == "ship_verified_revision")
            #expect(portfolio.templateRecommendations[0].stage == .recommended)
            #expect(portfolio.templateRecommendations[1].templateID == "restart_reasoning_chain")
            #expect(portfolio.templateRecommendations[1].stage == .mixed)
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
