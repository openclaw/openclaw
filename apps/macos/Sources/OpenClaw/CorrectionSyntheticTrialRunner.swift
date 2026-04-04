import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit

@MainActor
@Observable
final class CorrectionSyntheticTrialRunner {
    enum RunMode: Equatable {
        case single
        case queue
    }

    struct Context: Equatable {
        let templateID: String
        let templateLabel: String
        let diagnosisLabel: String
        let prescriptionLine: String
        let likelyRootCause: String?
        let evidence: [String]
        let successfulBotLabels: [String]
        let failedBotLabels: [String]
        let successCount: Int
        let failureCount: Int
    }

    struct Assessment: Equatable {
        let result: CorrectionSyntheticTrialResult
        let notes: String
        let diagnosisMatched: Bool
        let evidenceMatched: Int
        let remedyMatched: Bool
        let hasCheckpoint: Bool
        let wordCount: Int
        let strongNegativeSignal: Bool
    }

    struct RunResult {
        let plan: CorrectionSyntheticTrialExecutionPlan
        let sessionKey: String
        let result: CorrectionSyntheticTrialResult
        let notes: String
        let replyText: String?
        let snapshot: CorrectionCasebookSnapshot
    }

    struct QueueRunResult {
        let snapshot: CorrectionCasebookSnapshot
        let executedRunCount: Int
        let passedRunCount: Int
        let failedRunCount: Int
    }

    struct BatchProgress: Equatable {
        let plannedRunCount: Int
        let completedRunCount: Int
        let passedRunCount: Int
        let failedRunCount: Int

        var remainingRunCount: Int {
            max(0, self.plannedRunCount - self.completedRunCount)
        }
    }

    enum RunnerError: LocalizedError {
        case alreadyRunning
        case missingContext(String)
        case waitTimedOut(String)
        case waitFailed(String)
        case emptyAssistantReply

        var errorDescription: String? {
            switch self {
            case .alreadyRunning:
                return "A synthetic validation run is already in progress."
            case let .missingContext(templateLabel):
                return "The casebook does not have enough template context to validate \(templateLabel) yet."
            case let .waitTimedOut(templateLabel):
                return "Synthetic validation for \(templateLabel) timed out before the agent produced a usable reply."
            case let .waitFailed(message):
                return message
            case .emptyAssistantReply:
                return "The synthetic bot did not return any assistant text to evaluate."
            }
        }
    }

    private struct AgentWaitResponse: Decodable {
        let status: String?
        let error: String?
    }

    static let shared = CorrectionSyntheticTrialRunner()

    nonisolated private static let evidenceLineLimit = 4
    nonisolated private static let historyLimit = 40
    nonisolated private static let runTimeoutMs = 45_000
    nonisolated private static let checkpointKeywords: Set<String> = [
        "artifact", "checkpoint", "deliver", "diff", "log", "output",
        "patch", "proof", "ship", "verify",
    ]
    nonisolated private static let actionKeywords: Set<String> = [
        "apply", "check", "compare", "deliver", "fix", "patch",
        "rerun", "ship", "trace", "validate", "verify",
    ]
    nonisolated private static let strongNegativePhrases = [
        "as an ai",
        "cannot access",
        "can't access",
        "need more context",
        "need more info",
        "need more information",
        "let me know",
        "not enough context",
    ]

    private(set) var isRunning = false
    private(set) var runMode: RunMode?
    private(set) var currentPlan: CorrectionSyntheticTrialExecutionPlan?
    private(set) var batchProgress: BatchProgress?
    private(set) var lastOutcome: CorrectionSyntheticTrialResult?
    private(set) var lastRunSummary: String?

    func runNext(casebook: CorrectionCasebookSnapshot) async throws -> RunResult? {
        guard let plan = casebook.nextSyntheticTrialRun() else {
            return nil
        }
        guard !self.isRunning else {
            throw RunnerError.alreadyRunning
        }

        self.isRunning = true
        self.runMode = .single
        self.batchProgress = nil
        defer {
            self.isRunning = false
            self.runMode = nil
            self.currentPlan = nil
            self.batchProgress = nil
        }

        let result = try await self.execute(plan: plan, casebook: casebook)
        self.lastOutcome = result.result
        self.lastRunSummary = Self.summaryLine(plan: plan, result: result.result, notes: result.notes)
        return result
    }

    func runPending(casebook: CorrectionCasebookSnapshot) async throws -> QueueRunResult? {
        guard !self.isRunning else {
            throw RunnerError.alreadyRunning
        }

        let pendingRunCount = Self.pendingRunCount(casebook: casebook)
        guard pendingRunCount > 0 else {
            return nil
        }

        self.isRunning = true
        self.runMode = .queue
        self.batchProgress = BatchProgress(
            plannedRunCount: pendingRunCount,
            completedRunCount: 0,
            passedRunCount: 0,
            failedRunCount: 0)
        self.lastRunSummary = "Running \(pendingRunCount) pending synthetic validation run(s)..."

        defer {
            self.isRunning = false
            self.runMode = nil
            self.currentPlan = nil
            self.batchProgress = nil
        }

        var snapshot = casebook
        var executedRunCount = 0
        var passedRunCount = 0
        var failedRunCount = 0

        while let plan = snapshot.nextSyntheticTrialRun() {
            let result = try await self.execute(plan: plan, casebook: snapshot)
            snapshot = result.snapshot
            executedRunCount += 1
            if result.result == .passed {
                passedRunCount += 1
            } else if result.result == .failed {
                failedRunCount += 1
            }
            self.batchProgress = BatchProgress(
                plannedRunCount: pendingRunCount,
                completedRunCount: executedRunCount,
                passedRunCount: passedRunCount,
                failedRunCount: failedRunCount)
            self.lastOutcome = result.result
            self.lastRunSummary = Self.queueProgressLine(
                progress: self.batchProgress,
                currentPlan: snapshot.nextSyntheticTrialRun())
        }

        let finalProgress = BatchProgress(
            plannedRunCount: pendingRunCount,
            completedRunCount: executedRunCount,
            passedRunCount: passedRunCount,
            failedRunCount: failedRunCount)
        self.lastOutcome = failedRunCount > 0 ? .failed : .passed
        self.lastRunSummary = Self.queueCompletionLine(progress: finalProgress)

        return QueueRunResult(
            snapshot: snapshot,
            executedRunCount: executedRunCount,
            passedRunCount: passedRunCount,
            failedRunCount: failedRunCount)
    }

    func run(
        plan: CorrectionSyntheticTrialExecutionPlan,
        casebook: CorrectionCasebookSnapshot) async throws -> RunResult
    {
        guard !self.isRunning else {
            throw RunnerError.alreadyRunning
        }

        self.isRunning = true
        defer {
            self.isRunning = false
            self.runMode = nil
            self.currentPlan = nil
            self.batchProgress = nil
        }

        self.runMode = .single
        let result = try await self.execute(plan: plan, casebook: casebook)
        self.lastOutcome = result.result
        self.lastRunSummary = Self.summaryLine(plan: plan, result: result.result, notes: result.notes)
        return result
    }

    private func waitForRun(runId: String) async throws -> AgentWaitResponse {
        let data = try await ControlChannel.shared.request(
            method: "agent.wait",
            params: [
                "runId": AnyHashable(runId),
                "timeoutMs": AnyHashable(Self.runTimeoutMs),
            ],
            timeoutMs: Double(Self.runTimeoutMs + 2_000))
        return (try? JSONDecoder().decode(AgentWaitResponse.self, from: data))
            ?? AgentWaitResponse(status: nil, error: nil)
    }

    private func execute(
        plan: CorrectionSyntheticTrialExecutionPlan,
        casebook: CorrectionCasebookSnapshot) async throws -> RunResult
    {
        guard let context = Self.context(templateID: plan.templateID, casebook: casebook) else {
            throw RunnerError.missingContext(plan.templateLabel)
        }

        self.currentPlan = plan
        if self.runMode == .queue, let batchProgress = self.batchProgress {
            self.lastRunSummary = Self.queueProgressLine(progress: batchProgress, currentPlan: plan)
        } else {
            self.lastRunSummary = "Running synthetic validation for \(plan.templateLabel) round \(plan.iteration)..."
        }

        let sessionKey = Self.sessionKey(for: plan)
        defer {
            Task { try? await SessionActions.deleteSession(key: sessionKey) }
        }

        var replyText: String?
        var result: CorrectionSyntheticTrialResult = .failed
        var notes = "Synthetic validation did not complete."

        do {
            let response = try await GatewayConnection.shared.chatSend(
                sessionKey: sessionKey,
                message: Self.buildPrompt(plan: plan, context: context),
                thinking: "medium",
                idempotencyKey: UUID().uuidString.lowercased(),
                attachments: [],
                timeoutMs: Self.runTimeoutMs)

            let wait = try await self.waitForRun(runId: response.runId)
            if wait.status == "timeout" {
                throw RunnerError.waitTimedOut(plan.templateLabel)
            }
            if wait.status == "error" {
                throw RunnerError.waitFailed(wait.error ?? "Synthetic validation failed before producing a final reply.")
            }

            replyText = try await Self.latestAssistantReply(sessionKey: sessionKey, limit: Self.historyLimit)
            let assessment = Self.evaluate(responseText: replyText ?? "", context: context)
            result = assessment.result
            notes = assessment.notes
        } catch {
            result = .failed
            notes = Self.truncate(error.localizedDescription)
        }

        let snapshot = CorrectionCasebookStore.recordSyntheticTrialOutcome(
            batchID: plan.batchID,
            templateID: plan.templateID,
            iteration: plan.iteration,
            result: result,
            notes: notes)

        return RunResult(
            plan: plan,
            sessionKey: sessionKey,
            result: result,
            notes: notes,
            replyText: replyText,
            snapshot: snapshot)
    }

    nonisolated static func context(
        templateID rawTemplateID: String,
        casebook: CorrectionCasebookSnapshot) -> Context?
    {
        let templateID = rawTemplateID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !templateID.isEmpty,
              let portfolio = casebook.templatePortfolio(templateID: templateID)
        else {
            return nil
        }

        var latestTreatment: (record: BotMedicalRecord, treatment: CorrectionTreatmentRecord)?
        var latestObservation: (record: BotMedicalRecord, observation: CorrectionObservation)?

        for record in casebook.records {
            for treatment in record.treatments {
                guard Self.matchesTemplate(treatment.remedyTemplateID, templateID: templateID) else { continue }
                if latestTreatment == nil || treatment.prescribedAtMs > latestTreatment!.treatment.prescribedAtMs {
                    latestTreatment = (record, treatment)
                }
            }

            for observation in record.observations {
                guard Self.matchesTemplate(observation.remedyTemplateID, templateID: templateID) else { continue }
                if latestObservation == nil || observation.observedAtMs > latestObservation!.observation.observedAtMs {
                    latestObservation = (record, observation)
                }
            }
        }

        let activeCase = casebook.activeCases
            .filter { Self.matchesTemplate($0.remedyTemplateID, templateID: templateID) }
            .max { $0.lastSeenAtMs < $1.lastSeenAtMs }

        let diagnosisLabel =
            Self.nonEmpty(latestTreatment?.treatment.diagnosisLabel)
            ?? Self.nonEmpty(latestObservation?.observation.diagnosisLabel)
            ?? Self.nonEmpty(activeCase?.diagnosisLabel)
            ?? portfolio.templateLabel
        let prescriptionLine =
            Self.nonEmpty(latestTreatment?.treatment.prescriptionLine)
            ?? Self.nonEmpty(latestObservation?.observation.prescriptionLine)
            ?? Self.nonEmpty(activeCase?.prescriptionLine)
            ?? "Apply \(portfolio.templateLabel)."
        let likelyRootCause =
            Self.nonEmpty(latestTreatment?.treatment.likelyRootCause)
            ?? Self.nonEmpty(latestObservation?.observation.likelyRootCause)

        var evidence: [String] = []
        evidence.append(contentsOf: latestObservation?.observation.evidence ?? [])
        if let runtimeSummary = Self.nonEmpty(latestTreatment?.treatment.runtimeEvidence?.assistantOutputSummary) {
            evidence.append("Latest runtime output: \(runtimeSummary)")
        }
        if let runtimeSummary = Self.nonEmpty(activeCase?.runtimeEvidence?.assistantOutputSummary) {
            evidence.append("Live lane output: \(runtimeSummary)")
        }
        if let rootCause = likelyRootCause {
            evidence.append("Repeated root cause: \(rootCause)")
        }
        if evidence.isEmpty {
            evidence.append("Diagnosis \(diagnosisLabel) has previously been closed by template \(portfolio.templateLabel).")
        }
        evidence = Self.uniqueOrdered(evidence).prefix(Self.evidenceLineLimit).map { $0 }

        return Context(
            templateID: templateID,
            templateLabel: portfolio.templateLabel,
            diagnosisLabel: diagnosisLabel,
            prescriptionLine: prescriptionLine,
            likelyRootCause: likelyRootCause,
            evidence: evidence,
            successfulBotLabels: Self.resolveBotLabels(portfolio.successfulSubjectIDs, casebook: casebook),
            failedBotLabels: Self.resolveBotLabels(portfolio.failedSubjectIDs, casebook: casebook),
            successCount: portfolio.successCount,
            failureCount: portfolio.failureCount)
    }

    nonisolated static func buildPrompt(
        plan: CorrectionSyntheticTrialExecutionPlan,
        context: Context) -> String
    {
        let evidenceLines = context.evidence.enumerated().map { index, line in
            "\(index + 1). \(line)"
        }.joined(separator: "\n")
        let rootCauseLine = context.likelyRootCause.map { "Likely root cause: \($0)\n" } ?? ""
        let cleanBotLine = context.successfulBotLabels.isEmpty
            ? ""
            : "Previously fixed cleanly on: \(context.successfulBotLabels.joined(separator: ", ")).\n"
        let failureBotLine = context.failedBotLabels.isEmpty
            ? ""
            : "Previously failed or was superseded on: \(context.failedBotLabels.joined(separator: ", ")).\n"

        return """
        You are \(plan.syntheticBotLabel), a \(plan.persona) focused on \(plan.specialty) work with a \(plan.temperament) temperament.

        This is synthetic correction validation run \(plan.iteration) for remedy template "\(context.templateLabel)".
        Act like a drifting bot that matches the case below, then answer with the corrected intervention note that would actually close the case.

        Diagnosis: \(context.diagnosisLabel)
        Required remedy: \(context.prescriptionLine)
        \(rootCauseLine)\(cleanBotLine)\(failureBotLine)Evidence chain:
        \(evidenceLines)

        Return one concise intervention note that:
        1. Names the failure mode precisely.
        2. Uses the evidence instead of generic filler.
        3. Applies the required remedy concretely.
        4. Ends with the first verifiable output, artifact, or checkpoint.

        Do not ask for more context.
        Do not explain that this is a simulation.
        """
    }

    nonisolated static func evaluate(responseText rawResponseText: String, context: Context) -> Assessment {
        let responseText = Self.condenseWhitespace(rawResponseText)
        let responseWords = responseText.split(whereSeparator: \.isWhitespace)
        let loweredResponse = responseText.lowercased()
        let diagnosisKeywords = Self.keywords(from: context.diagnosisLabel)
            .union(Self.keywords(from: context.likelyRootCause ?? ""))
        let evidenceKeywords = Set(context.evidence.flatMap(Self.keywords(from:)))
        let remedyKeywords = Self.keywords(from: context.prescriptionLine)
            .union(Self.keywords(from: context.templateLabel))
        let diagnosisMatched = !diagnosisKeywords.isDisjoint(with: Self.keywords(from: loweredResponse))
        let evidenceMatched = Self.keywords(from: loweredResponse).intersection(evidenceKeywords).count
        let remedyMatched = !remedyKeywords.isDisjoint(with: Self.keywords(from: loweredResponse))
        let hasCheckpoint =
            !Self.checkpointKeywords.isDisjoint(with: Self.keywords(from: loweredResponse)) ||
            loweredResponse.contains("1.") ||
            loweredResponse.contains("first ") ||
            loweredResponse.contains("next ")
        let hasActionSignal = !Self.actionKeywords.isDisjoint(with: Self.keywords(from: loweredResponse))
        let strongNegativeSignal = Self.strongNegativePhrases.contains { loweredResponse.contains($0) }
        let enoughSubstance = responseWords.count >= 24

        let passed =
            enoughSubstance &&
            diagnosisMatched &&
            evidenceMatched >= 2 &&
            (remedyMatched || hasActionSignal) &&
            hasCheckpoint &&
            !strongNegativeSignal

        let reasons: [String] = {
            if passed {
                return [
                    "matched diagnosis/root cause",
                    "used \(evidenceMatched) evidence keyword(s)",
                    hasCheckpoint ? "ended with a verifiable checkpoint" : nil,
                ].compactMap { $0 }
            }

            return [
                enoughSubstance ? nil : "reply stayed too thin",
                diagnosisMatched ? nil : "missed the failure mode",
                evidenceMatched >= 2 ? nil : "did not ground itself in the evidence chain",
                (remedyMatched || hasActionSignal) ? nil : "did not apply the remedy concretely",
                hasCheckpoint ? nil : "ended without a verifiable checkpoint",
                strongNegativeSignal ? "fell back to generic stalling language" : nil,
            ].compactMap { $0 }
        }()
        let prefix = passed ? "PASS" : "FAIL"
        let snippet = Self.truncate(responseText, limit: 160)
        let notes = "\(prefix): \(reasons.joined(separator: "; ")). Reply: \(snippet)"

        return Assessment(
            result: passed ? .passed : .failed,
            notes: Self.truncate(notes),
            diagnosisMatched: diagnosisMatched,
            evidenceMatched: evidenceMatched,
            remedyMatched: remedyMatched || hasActionSignal,
            hasCheckpoint: hasCheckpoint,
            wordCount: responseWords.count,
            strongNegativeSignal: strongNegativeSignal)
    }

    nonisolated static func summaryLine(
        plan: CorrectionSyntheticTrialExecutionPlan,
        result: CorrectionSyntheticTrialResult,
        notes: String) -> String
    {
        let verb = switch result {
        case .passed: "passed"
        case .failed: "failed"
        case .pending: "is pending"
        }
        return "Synthetic trial \(plan.templateLabel) round \(plan.iteration) \(verb): \(Self.truncate(notes, limit: 180))"
    }

    nonisolated static func queueProgressLine(
        progress: BatchProgress?,
        currentPlan: CorrectionSyntheticTrialExecutionPlan?) -> String
    {
        let completed = progress?.completedRunCount ?? 0
        let planned = progress?.plannedRunCount ?? 0
        let failed = progress?.failedRunCount ?? 0
        let nextLine = currentPlan.map {
            " Running \($0.templateLabel) round \($0.iteration) on \($0.syntheticBotLabel)."
        } ?? ""
        return "\(completed)/\(planned) synthetic validation run(s) complete, \(failed) failed.\(nextLine)"
    }

    nonisolated static func queueCompletionLine(progress: BatchProgress) -> String {
        if progress.failedRunCount > 0 {
            return "Synthetic validation queue finished with \(progress.failedRunCount) failed run(s) across \(progress.completedRunCount) executed run(s)."
        }
        return "Synthetic validation queue finished cleanly: \(progress.passedRunCount)/\(progress.completedRunCount) run(s) passed."
    }

    nonisolated static func pendingRunCount(casebook: CorrectionCasebookSnapshot) -> Int {
        casebook.currentSyntheticTrialBatch()?.runs.count { $0.result == .pending } ?? 0
    }

    private nonisolated static func latestAssistantReply(sessionKey: String, limit: Int) async throws -> String {
        let history = try await GatewayConnection.shared.chatHistory(sessionKey: sessionKey, limit: limit)
        let messages = history.messages ?? []
        let decoded: [OpenClawChatMessage] = messages.compactMap { item in
            guard let data = try? JSONEncoder().encode(item) else { return nil }
            return try? JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        }
        guard let assistant = decoded.last(where: { $0.role == "assistant" }) else {
            throw RunnerError.emptyAssistantReply
        }
        let text = assistant.content.compactMap(\.text).joined(separator: "\n")
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw RunnerError.emptyAssistantReply
        }
        return trimmed
    }

    private nonisolated static func sessionKey(for plan: CorrectionSyntheticTrialExecutionPlan) -> String {
        let batchComponent = Self.sanitizeSessionComponent(String(plan.batchID.prefix(8)))
        let templateComponent = Self.sanitizeSessionComponent(plan.templateID)
        let botComponent = Self.sanitizeSessionComponent(String(plan.syntheticBotID.suffix(6)))
        return "synthetic-\(batchComponent)-\(templateComponent)-r\(plan.iteration)-\(botComponent)"
    }

    private nonisolated static func resolveBotLabels(
        _ subjectIDs: [String],
        casebook: CorrectionCasebookSnapshot) -> [String]
    {
        subjectIDs.compactMap { subjectID in
            Self.nonEmpty(casebook.record(subjectID: subjectID)?.label) ?? Self.nonEmpty(subjectID)
        }
    }

    private nonisolated static func uniqueOrdered(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.compactMap { value in
            let normalized = Self.condenseWhitespace(value)
            guard !normalized.isEmpty else { return nil }
            let key = normalized.lowercased()
            guard !seen.contains(key) else { return nil }
            seen.insert(key)
            return normalized
        }
    }

    private nonisolated static func matchesTemplate(_ rawTemplateID: String?, templateID: String) -> Bool {
        rawTemplateID?.trimmingCharacters(in: .whitespacesAndNewlines) == templateID
    }

    private nonisolated static func condenseWhitespace(_ text: String) -> String {
        text
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private nonisolated static func keywords(from text: String) -> Set<String> {
        let parts = text.lowercased().split { character in
            !character.isLetter && !character.isNumber
        }
        return Set(parts.compactMap { part in
            guard part.count >= 4 else { return nil }
            return String(part)
        })
    }

    private nonisolated static func sanitizeSessionComponent(_ value: String) -> String {
        let lowered = value.lowercased()
        let mapped = lowered.map { character -> Character in
            if character.isLetter || character.isNumber {
                return character
            }
            return "-"
        }
        let condensed = String(mapped).replacingOccurrences(of: "--+", with: "-", options: .regularExpression)
        let trimmed = condensed.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return trimmed.isEmpty ? "trial" : trimmed
    }

    private nonisolated static func truncate(_ text: String, limit: Int = 240) -> String {
        let condensed = Self.condenseWhitespace(text)
        guard condensed.count > limit else { return condensed }
        let endIndex = condensed.index(condensed.startIndex, offsetBy: limit)
        return "\(condensed[..<endIndex])..."
    }

    private nonisolated static func nonEmpty(_ text: String?) -> String? {
        guard let text else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
