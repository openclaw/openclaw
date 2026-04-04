import Foundation
import Testing
@testable import OpenClawKit

@Suite(.serialized)
struct CorrectionTemplatePortfolioTests {
    @Test
    func promotesCandidateTemplateAfterThreeSuccessfulBots() throws {
        try self.withTemporaryCasebookStore {
            let rounds: [(subjectID: String, diagnosisID: String, fingerprint: String)] = [
                ("bot:main", "stall_main", "stall-main-1"),
                ("bot:watchdog", "stall_watchdog", "stall-watchdog-1"),
                ("bot:triage", "stall_triage", "stall-triage-1"),
            ]

            for (index, round) in rounds.enumerated() {
                let baseTime = Date(timeIntervalSince1970: Double(100 + index * 10))
                let input = CorrectionCaseInput(
                    subjectID: round.subjectID,
                    subjectLabel: round.subjectID,
                    role: "bot",
                    diagnosisID: round.diagnosisID,
                    diagnosisLabel: round.diagnosisID,
                    severity: "warning",
                    summary: "The bot is stalled.",
                    evidence: ["No fresh verified output"],
                    prescriptionLine: "Ship one verified output.",
                    remedyTemplateID: "ship_one_verified_output",
                    remedyTemplateLabel: "Ship One Verified Output",
                    likelyRootCause: "The lane is narrating instead of shipping.",
                    fingerprint: round.fingerprint)

                _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: baseTime)
                _ = CorrectionCasebookStore.recordOutcome(
                    subjectID: round.subjectID,
                    diagnosisID: round.diagnosisID,
                    outcome: .resolved,
                    recordedAt: baseTime.addingTimeInterval(1))
            }

            let snapshot = CorrectionCasebookStore.load()
            let portfolio = try #require(snapshot.templatePortfolio(templateID: "ship_one_verified_output"))
            let summary = snapshot.templatePortfolioSummary()

            #expect(portfolio.stage == .candidate)
            #expect(portfolio.successCount == 3)
            #expect(portfolio.failureCount == 0)
            #expect(portfolio.successfulBotCount == 3)
            #expect(portfolio.roundsRemainingForCandidate == 0)
            #expect(portfolio.botsRemainingForCandidate == 0)
            #expect(summary.candidateTemplateCount == 1)
            #expect(summary.readyForSyntheticTrials == false)
        }
    }

    @Test
    func blocksCandidatePromotionWhenFailuresExist() throws {
        try self.withTemporaryCasebookStore {
            let successSubjects = ["bot:main", "bot:watchdog", "bot:triage"]
            for (index, subjectID) in successSubjects.enumerated() {
                let diagnosisID = "stall_\(index)"
                let time = Date(timeIntervalSince1970: Double(200 + index * 10))
                let input = CorrectionCaseInput(
                    subjectID: subjectID,
                    subjectLabel: subjectID,
                    role: "bot",
                    diagnosisID: diagnosisID,
                    diagnosisLabel: diagnosisID,
                    severity: "warning",
                    summary: "The bot is stalled.",
                    evidence: ["No fresh verified output"],
                    prescriptionLine: "Ship one verified output.",
                    remedyTemplateID: "ship_one_verified_output",
                    remedyTemplateLabel: "Ship One Verified Output",
                    likelyRootCause: "The lane is narrating instead of shipping.",
                    fingerprint: "success-\(index)")
                _ = CorrectionCasebookStore.syncActiveCases([input], observedAt: time)
                _ = CorrectionCasebookStore.recordOutcome(
                    subjectID: subjectID,
                    diagnosisID: diagnosisID,
                    outcome: .resolved,
                    recordedAt: time.addingTimeInterval(1))
            }

            let failedInput = CorrectionCaseInput(
                subjectID: "bot:review",
                subjectLabel: "bot:review",
                role: "bot",
                diagnosisID: "stall_review",
                diagnosisLabel: "stall_review",
                severity: "critical",
                summary: "The bot is still stalled.",
                evidence: ["No fresh verified output"],
                prescriptionLine: "Ship one verified output.",
                remedyTemplateID: "ship_one_verified_output",
                remedyTemplateLabel: "Ship One Verified Output",
                likelyRootCause: "The lane stayed blocked.",
                fingerprint: "failed-1")
            _ = CorrectionCasebookStore.syncActiveCases([failedInput], observedAt: Date(timeIntervalSince1970: 260))
            _ = CorrectionCasebookStore.recordOutcome(
                subjectID: "bot:review",
                diagnosisID: "stall_review",
                outcome: .failed,
                recordedAt: Date(timeIntervalSince1970: 261))

            let snapshot = CorrectionCasebookStore.load()
            let portfolio = try #require(snapshot.templatePortfolio(templateID: "ship_one_verified_output"))

            #expect(portfolio.stage == .mixed)
            #expect(portfolio.isCandidate == false)
            #expect(portfolio.successCount == 3)
            #expect(portfolio.failureCount == 1)
            #expect(portfolio.successfulBotCount == 3)
            #expect(portfolio.failedBotCount == 1)
        }
    }

    @Test
    func syntheticReadinessRequiresThreeCandidateTemplates() {
        let candidates = [
            CorrectionTemplatePortfolioStats(
                templateID: "template-a",
                templateLabel: "Template A",
                prescribedCount: 3,
                successCount: 3,
                failureCount: 0,
                activeCount: 0,
                successfulSubjectIDs: ["bot:1", "bot:2", "bot:3"],
                failedSubjectIDs: []),
            CorrectionTemplatePortfolioStats(
                templateID: "template-b",
                templateLabel: "Template B",
                prescribedCount: 4,
                successCount: 4,
                failureCount: 0,
                activeCount: 0,
                successfulSubjectIDs: ["bot:4", "bot:5", "bot:6", "bot:7"],
                failedSubjectIDs: []),
            CorrectionTemplatePortfolioStats(
                templateID: "template-c",
                templateLabel: "Template C",
                prescribedCount: 3,
                successCount: 3,
                failureCount: 0,
                activeCount: 0,
                successfulSubjectIDs: ["bot:8", "bot:9", "bot:10"],
                failedSubjectIDs: []),
        ]

        let summary = CorrectionTemplatePortfolioSummary(portfolios: candidates)

        #expect(summary.candidateTemplateCount == 3)
        #expect(summary.readyForSyntheticTrials == true)
        #expect(summary.candidateTemplateIDs == ["template-a", "template-b", "template-c"])
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
