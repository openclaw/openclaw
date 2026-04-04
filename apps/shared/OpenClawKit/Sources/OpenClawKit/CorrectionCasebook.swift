import Foundation

public enum CorrectionOutcome: String, Codable, Sendable {
    case resolved
    case failed
    case superseded

    public var title: String {
        switch self {
        case .resolved: "Resolved"
        case .failed: "Failed"
        case .superseded: "Superseded"
        }
    }
}

public enum CorrectionTreatmentResult: String, Codable, Sendable {
    case pending
    case resolved
    case failed
    case superseded
}

public struct CorrectionExternalResearchItem: Codable, Sendable, Hashable, Identifiable {
    public var id: String { self.url }

    public var title: String
    public var url: String
    public var source: String
    public var snippet: String

    public init(
        title: String,
        url: String,
        source: String,
        snippet: String)
    {
        self.title = title
        self.url = url
        self.source = source
        self.snippet = snippet
    }
}

public struct CorrectionRuntimeEvidence: Codable, Sendable, Hashable {
    public var assistantOutputAtMs: Int?
    public var assistantOutputSummary: String?
    public var assistantOutputHasArtifact: Bool?
    public var outputAfterRoundStart: Bool?
    public var interventionDispatchedAtMs: Int?
    public var interventionDispatchSummary: String?
    public var externalResearchFetchedAtMs: Int?
    public var externalResearchQuery: String?
    public var externalResearchSummary: String?
    public var externalResearchItems: [CorrectionExternalResearchItem]

    public init(
        assistantOutputAtMs: Int? = nil,
        assistantOutputSummary: String? = nil,
        assistantOutputHasArtifact: Bool? = nil,
        outputAfterRoundStart: Bool? = nil,
        interventionDispatchedAtMs: Int? = nil,
        interventionDispatchSummary: String? = nil,
        externalResearchFetchedAtMs: Int? = nil,
        externalResearchQuery: String? = nil,
        externalResearchSummary: String? = nil,
        externalResearchItems: [CorrectionExternalResearchItem] = [])
    {
        self.assistantOutputAtMs = assistantOutputAtMs
        self.assistantOutputSummary = assistantOutputSummary
        self.assistantOutputHasArtifact = assistantOutputHasArtifact
        self.outputAfterRoundStart = outputAfterRoundStart
        self.interventionDispatchedAtMs = interventionDispatchedAtMs
        self.interventionDispatchSummary = interventionDispatchSummary
        self.externalResearchFetchedAtMs = externalResearchFetchedAtMs
        self.externalResearchQuery = externalResearchQuery
        self.externalResearchSummary = externalResearchSummary
        self.externalResearchItems = externalResearchItems
    }
}

public struct CorrectionCaseInput: Sendable {
    public let subjectID: String
    public let subjectLabel: String
    public let role: String
    public let diagnosisID: String
    public let diagnosisLabel: String
    public let severity: String
    public let summary: String
    public let evidence: [String]
    public let prescriptionLine: String
    public let remedyTemplateID: String?
    public let remedyTemplateLabel: String?
    public let likelyRootCause: String?
    public let runtimeEvidence: CorrectionRuntimeEvidence?
    public let fingerprint: String

    public init(
        subjectID: String,
        subjectLabel: String,
        role: String,
        diagnosisID: String,
        diagnosisLabel: String,
        severity: String,
        summary: String,
        evidence: [String],
        prescriptionLine: String,
        remedyTemplateID: String? = nil,
        remedyTemplateLabel: String? = nil,
        likelyRootCause: String? = nil,
        runtimeEvidence: CorrectionRuntimeEvidence? = nil,
        fingerprint: String)
    {
        self.subjectID = subjectID
        self.subjectLabel = subjectLabel
        self.role = role
        self.diagnosisID = diagnosisID
        self.diagnosisLabel = diagnosisLabel
        self.severity = severity
        self.summary = summary
        self.evidence = evidence
        self.prescriptionLine = prescriptionLine
        self.remedyTemplateID = remedyTemplateID
        self.remedyTemplateLabel = remedyTemplateLabel
        self.likelyRootCause = likelyRootCause
        self.runtimeEvidence = runtimeEvidence
        self.fingerprint = fingerprint
    }
}

public struct CorrectionObservation: Codable, Sendable, Identifiable {
    public let id: String
    public var observedAtMs: Int
    public var diagnosisID: String
    public var diagnosisLabel: String
    public var severity: String
    public var summary: String
    public var evidence: [String]
    public var prescriptionLine: String
    public var remedyTemplateID: String?
    public var remedyTemplateLabel: String?
    public var likelyRootCause: String?
    public var runtimeEvidence: CorrectionRuntimeEvidence?
    public var fingerprint: String

    public init(
        id: String,
        observedAtMs: Int,
        diagnosisID: String,
        diagnosisLabel: String,
        severity: String,
        summary: String,
        evidence: [String],
        prescriptionLine: String,
        remedyTemplateID: String?,
        remedyTemplateLabel: String?,
        likelyRootCause: String?,
        runtimeEvidence: CorrectionRuntimeEvidence? = nil,
        fingerprint: String)
    {
        self.id = id
        self.observedAtMs = observedAtMs
        self.diagnosisID = diagnosisID
        self.diagnosisLabel = diagnosisLabel
        self.severity = severity
        self.summary = summary
        self.evidence = evidence
        self.prescriptionLine = prescriptionLine
        self.remedyTemplateID = remedyTemplateID
        self.remedyTemplateLabel = remedyTemplateLabel
        self.likelyRootCause = likelyRootCause
        self.runtimeEvidence = runtimeEvidence
        self.fingerprint = fingerprint
    }
}

public struct CorrectionTreatmentRecord: Codable, Sendable, Identifiable {
    public let id: String
    public var diagnosisID: String
    public var diagnosisLabel: String
    public var remedyTemplateID: String?
    public var remedyTemplateLabel: String?
    public var prescribedAtMs: Int
    public var resolvedAtMs: Int?
    public var result: CorrectionTreatmentResult
    public var prescriptionLine: String
    public var likelyRootCause: String?
    public var runtimeEvidence: CorrectionRuntimeEvidence?
    public var fingerprint: String

    public init(
        id: String,
        diagnosisID: String,
        diagnosisLabel: String,
        remedyTemplateID: String?,
        remedyTemplateLabel: String?,
        prescribedAtMs: Int,
        resolvedAtMs: Int?,
        result: CorrectionTreatmentResult,
        prescriptionLine: String,
        likelyRootCause: String?,
        runtimeEvidence: CorrectionRuntimeEvidence? = nil,
        fingerprint: String)
    {
        self.id = id
        self.diagnosisID = diagnosisID
        self.diagnosisLabel = diagnosisLabel
        self.remedyTemplateID = remedyTemplateID
        self.remedyTemplateLabel = remedyTemplateLabel
        self.prescribedAtMs = prescribedAtMs
        self.resolvedAtMs = resolvedAtMs
        self.result = result
        self.prescriptionLine = prescriptionLine
        self.likelyRootCause = likelyRootCause
        self.runtimeEvidence = runtimeEvidence
        self.fingerprint = fingerprint
    }
}

public struct CorrectionConditionStats: Codable, Sendable {
    public var diagnosisID: String
    public var diagnosisLabel: String
    public var occurrenceCount: Int
    public var successCount: Int
    public var failureCount: Int
    public var lastSeenAtMs: Int?
    public var lastResolvedAtMs: Int?
    public var lastOutcome: CorrectionOutcome?
    public var lastPrescriptionLine: String
    public var lastRootCause: String

    public init(
        diagnosisID: String,
        diagnosisLabel: String,
        occurrenceCount: Int = 0,
        successCount: Int = 0,
        failureCount: Int = 0,
        lastSeenAtMs: Int? = nil,
        lastResolvedAtMs: Int? = nil,
        lastOutcome: CorrectionOutcome? = nil,
        lastPrescriptionLine: String = "",
        lastRootCause: String = "")
    {
        self.diagnosisID = diagnosisID
        self.diagnosisLabel = diagnosisLabel
        self.occurrenceCount = occurrenceCount
        self.successCount = successCount
        self.failureCount = failureCount
        self.lastSeenAtMs = lastSeenAtMs
        self.lastResolvedAtMs = lastResolvedAtMs
        self.lastOutcome = lastOutcome
        self.lastPrescriptionLine = lastPrescriptionLine
        self.lastRootCause = lastRootCause
    }

    public var recurrenceCount: Int {
        max(0, self.occurrenceCount - 1)
    }
}

public struct CorrectionTemplateStats: Codable, Sendable {
    public var templateID: String
    public var templateLabel: String
    public var prescribedCount: Int
    public var successCount: Int
    public var failureCount: Int
    public var lastUsedAtMs: Int?

    public init(
        templateID: String,
        templateLabel: String,
        prescribedCount: Int = 0,
        successCount: Int = 0,
        failureCount: Int = 0,
        lastUsedAtMs: Int? = nil)
    {
        self.templateID = templateID
        self.templateLabel = templateLabel
        self.prescribedCount = prescribedCount
        self.successCount = successCount
        self.failureCount = failureCount
        self.lastUsedAtMs = lastUsedAtMs
    }
}

public struct BotMedicalRecord: Codable, Sendable, Identifiable {
    public var id: String { self.subjectID }

    public var subjectID: String
    public var label: String
    public var role: String
    public var createdAtMs: Int
    public var updatedAtMs: Int
    public var currentDiagnosisID: String?
    public var currentTreatmentTemplateID: String?
    public var observations: [CorrectionObservation]
    public var conditions: [CorrectionConditionStats]
    public var templates: [CorrectionTemplateStats]
    public var treatments: [CorrectionTreatmentRecord]

    public init(
        subjectID: String,
        label: String,
        role: String,
        createdAtMs: Int,
        updatedAtMs: Int,
        currentDiagnosisID: String? = nil,
        currentTreatmentTemplateID: String? = nil,
        observations: [CorrectionObservation] = [],
        conditions: [CorrectionConditionStats] = [],
        templates: [CorrectionTemplateStats] = [],
        treatments: [CorrectionTreatmentRecord] = [])
    {
        self.subjectID = subjectID
        self.label = label
        self.role = role
        self.createdAtMs = createdAtMs
        self.updatedAtMs = updatedAtMs
        self.currentDiagnosisID = currentDiagnosisID
        self.currentTreatmentTemplateID = currentTreatmentTemplateID
        self.observations = observations
        self.conditions = conditions
        self.templates = templates
        self.treatments = treatments
    }

    public func condition(diagnosisID: String) -> CorrectionConditionStats? {
        self.conditions.first { $0.diagnosisID == diagnosisID }
    }

    public func latestTreatment(diagnosisID: String) -> CorrectionTreatmentRecord? {
        self.treatments
            .filter { $0.diagnosisID == diagnosisID }
            .max { $0.prescribedAtMs < $1.prescribedAtMs }
    }
}

public struct CorrectionActiveCase: Codable, Sendable {
    public var key: String
    public var subjectID: String
    public var diagnosisID: String
    public var diagnosisLabel: String
    public var fingerprint: String
    public var firstSeenAtMs: Int
    public var lastSeenAtMs: Int
    public var treatmentRecordID: String
    public var prescriptionLine: String
    public var remedyTemplateID: String?
    public var remedyTemplateLabel: String?
    public var runtimeEvidence: CorrectionRuntimeEvidence?

    public init(
        key: String,
        subjectID: String,
        diagnosisID: String,
        diagnosisLabel: String,
        fingerprint: String,
        firstSeenAtMs: Int,
        lastSeenAtMs: Int,
        treatmentRecordID: String,
        prescriptionLine: String,
        remedyTemplateID: String?,
        remedyTemplateLabel: String?,
        runtimeEvidence: CorrectionRuntimeEvidence? = nil)
    {
        self.key = key
        self.subjectID = subjectID
        self.diagnosisID = diagnosisID
        self.diagnosisLabel = diagnosisLabel
        self.fingerprint = fingerprint
        self.firstSeenAtMs = firstSeenAtMs
        self.lastSeenAtMs = lastSeenAtMs
        self.treatmentRecordID = treatmentRecordID
        self.prescriptionLine = prescriptionLine
        self.remedyTemplateID = remedyTemplateID
        self.remedyTemplateLabel = remedyTemplateLabel
        self.runtimeEvidence = runtimeEvidence
    }
}

public struct CorrectionCasebookSnapshot: Codable, Sendable {
    public static let currentVersion = 2

    public var version: Int
    public var updatedAtMs: Int?
    public var records: [BotMedicalRecord]
    public var activeCases: [CorrectionActiveCase]
    public var syntheticTrials: [CorrectionSyntheticTrialBatch]

    private enum CodingKeys: String, CodingKey {
        case version
        case updatedAtMs
        case records
        case activeCases
        case syntheticTrials
    }

    public init(
        version: Int = Self.currentVersion,
        updatedAtMs: Int? = nil,
        records: [BotMedicalRecord] = [],
        activeCases: [CorrectionActiveCase] = [],
        syntheticTrials: [CorrectionSyntheticTrialBatch] = [])
    {
        self.version = version
        self.updatedAtMs = updatedAtMs
        self.records = records
        self.activeCases = activeCases
        self.syntheticTrials = syntheticTrials
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedVersion = try container.decodeIfPresent(Int.self, forKey: .version) ?? 1
        self.version = max(decodedVersion, Self.currentVersion)
        self.updatedAtMs = try container.decodeIfPresent(Int.self, forKey: .updatedAtMs)
        self.records = try container.decodeIfPresent([BotMedicalRecord].self, forKey: .records) ?? []
        self.activeCases = try container.decodeIfPresent([CorrectionActiveCase].self, forKey: .activeCases) ?? []
        self.syntheticTrials = try container.decodeIfPresent([CorrectionSyntheticTrialBatch].self, forKey: .syntheticTrials) ?? []
    }

    public func record(subjectID: String) -> BotMedicalRecord? {
        self.records.first { $0.subjectID == subjectID }
    }

    public func condition(subjectID: String, diagnosisID: String) -> CorrectionConditionStats? {
        self.record(subjectID: subjectID)?.condition(diagnosisID: diagnosisID)
    }

    public func latestTreatment(subjectID: String, diagnosisID: String) -> CorrectionTreatmentRecord? {
        self.record(subjectID: subjectID)?.latestTreatment(diagnosisID: diagnosisID)
    }

    public func templatePortfolio() -> [CorrectionTemplatePortfolioStats] {
        var prescribedCountByTemplate: [String: Int] = [:]
        var labelByTemplate: [String: String] = [:]
        var successCountByTemplate: [String: Int] = [:]
        var failureCountByTemplate: [String: Int] = [:]
        var activeCountByTemplate: [String: Int] = [:]
        var successSubjectsByTemplate: [String: Set<String>] = [:]
        var failureSubjectsByTemplate: [String: Set<String>] = [:]

        for record in self.records {
            for template in record.templates {
                prescribedCountByTemplate[template.templateID, default: 0] += template.prescribedCount
                if !template.templateLabel.isEmpty {
                    labelByTemplate[template.templateID] = template.templateLabel
                }
            }

            for treatment in record.treatments {
                guard let templateID = treatment.remedyTemplateID?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !templateID.isEmpty
                else {
                    continue
                }
                if let templateLabel = treatment.remedyTemplateLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !templateLabel.isEmpty
                {
                    labelByTemplate[templateID] = templateLabel
                }
                switch treatment.result {
                case .pending:
                    break
                case .resolved:
                    successCountByTemplate[templateID, default: 0] += 1
                    successSubjectsByTemplate[templateID, default: []].insert(record.subjectID)
                case .failed, .superseded:
                    failureCountByTemplate[templateID, default: 0] += 1
                    failureSubjectsByTemplate[templateID, default: []].insert(record.subjectID)
                }
            }
        }

        for activeCase in self.activeCases {
            guard let templateID = activeCase.remedyTemplateID?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !templateID.isEmpty
            else {
                continue
            }
            if let templateLabel = activeCase.remedyTemplateLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
               !templateLabel.isEmpty
            {
                labelByTemplate[templateID] = templateLabel
            }
            activeCountByTemplate[templateID, default: 0] += 1
        }

        let allTemplateIDs = Set(prescribedCountByTemplate.keys)
            .union(successCountByTemplate.keys)
            .union(failureCountByTemplate.keys)
            .union(activeCountByTemplate.keys)

        let portfolios = allTemplateIDs.map { templateID in
            CorrectionTemplatePortfolioStats(
                templateID: templateID,
                templateLabel: labelByTemplate[templateID] ?? templateID,
                prescribedCount: prescribedCountByTemplate[templateID, default: 0],
                successCount: successCountByTemplate[templateID, default: 0],
                failureCount: failureCountByTemplate[templateID, default: 0],
                activeCount: activeCountByTemplate[templateID, default: 0],
                successfulSubjectIDs: Array(successSubjectsByTemplate[templateID, default: []]).sorted(),
                failedSubjectIDs: Array(failureSubjectsByTemplate[templateID, default: []]).sorted())
        }

        return portfolios.sorted { lhs, rhs in
            if lhs.stage.sortRank == rhs.stage.sortRank {
                if lhs.successCount == rhs.successCount {
                    return lhs.templateID < rhs.templateID
                }
                return lhs.successCount > rhs.successCount
            }
            return lhs.stage.sortRank > rhs.stage.sortRank
        }
    }

    public func templatePortfolio(templateID rawTemplateID: String) -> CorrectionTemplatePortfolioStats? {
        let templateID = rawTemplateID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !templateID.isEmpty else { return nil }
        return self.templatePortfolio().first { $0.templateID == templateID }
    }

    public func templatePortfolioSummary() -> CorrectionTemplatePortfolioSummary {
        CorrectionTemplatePortfolioSummary(portfolios: self.templatePortfolio())
    }

    public func currentSyntheticTrialBatch() -> CorrectionSyntheticTrialBatch? {
        self.syntheticTrials.max { lhs, rhs in
            let lhsRank = lhs.completedAtMs == nil ? 1 : 0
            let rhsRank = rhs.completedAtMs == nil ? 1 : 0
            if lhsRank == rhsRank {
                return lhs.createdAtMs < rhs.createdAtMs
            }
            return lhsRank < rhsRank
        }
    }

    public func syntheticTrialTemplate(templateID rawTemplateID: String) -> CorrectionSyntheticTrialTemplateStats? {
        let templateID = rawTemplateID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !templateID.isEmpty,
              let batch = self.currentSyntheticTrialBatch()
        else {
            return nil
        }

        let relevantRuns = batch.runs.filter { $0.templateID == templateID }
        guard !relevantRuns.isEmpty else { return nil }
        let templateLabel = relevantRuns
            .map(\.templateLabel)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .last(where: { !$0.isEmpty }) ?? templateID
        let passedRunCount = relevantRuns.count { $0.result == .passed }
        let failedRunCount = relevantRuns.count { $0.result == .failed }
        let completedRunCount = relevantRuns.count { $0.result != .pending }
        let pendingRunCount = relevantRuns.count { $0.result == .pending }

        return CorrectionSyntheticTrialTemplateStats(
            templateID: templateID,
            templateLabel: templateLabel,
            syntheticBotLabel: batch.botProfile.label,
            plannedRunCount: relevantRuns.count,
            completedRunCount: completedRunCount,
            passedRunCount: passedRunCount,
            failedRunCount: failedRunCount,
            pendingRunCount: pendingRunCount)
    }

    public func nextSyntheticTrialRun(templateID rawTemplateID: String? = nil) -> CorrectionSyntheticTrialExecutionPlan? {
        let normalizedTemplateID = rawTemplateID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let templateIDFilter = normalizedTemplateID?.isEmpty == false ? normalizedTemplateID : nil
        guard let batch = self.currentSyntheticTrialBatch() else {
            return nil
        }

        guard let run = batch.runs
            .filter({ trial in
                trial.result == .pending &&
                    (templateIDFilter == nil || trial.templateID == templateIDFilter)
            })
            .sorted(by: { lhs, rhs in
                if lhs.templateID == rhs.templateID {
                    return lhs.iteration < rhs.iteration
                }
                return lhs.templateID < rhs.templateID
            })
            .first
        else {
            return nil
        }

        return CorrectionSyntheticTrialExecutionPlan(
            batchID: batch.id,
            templateID: run.templateID,
            templateLabel: run.templateLabel,
            iteration: run.iteration,
            syntheticBotID: batch.botProfile.id,
            syntheticBotLabel: batch.botProfile.label,
            persona: batch.botProfile.persona,
            specialty: batch.botProfile.specialty,
            temperament: batch.botProfile.temperament)
    }

    public func syntheticTrialSummary() -> CorrectionSyntheticTrialSummary {
        let portfolioSummary = self.templatePortfolioSummary()
        let activeBatch = self.currentSyntheticTrialBatch()
        let candidateTemplateIDs = portfolioSummary.candidateTemplateIDs.sorted()
        let templateStats = (activeBatch?.candidateTemplateIDs ?? candidateTemplateIDs)
            .compactMap(self.syntheticTrialTemplate(templateID:))
        let passedRunCount = templateStats.reduce(0) { $0 + $1.passedRunCount }
        let failedRunCount = templateStats.reduce(0) { $0 + $1.failedRunCount }
        let completedRunCount = templateStats.reduce(0) { $0 + $1.completedRunCount }
        let plannedRunCount = templateStats.reduce(0) { $0 + $1.plannedRunCount }
        let universalTemplateIDs = templateStats.filter(\.isUniversal).map(\.templateID)
        let failedTemplateIDs = templateStats.filter { $0.failedRunCount > 0 }.map(\.templateID)

        let stage: CorrectionSyntheticTrialSummary.Stage
        if !universalTemplateIDs.isEmpty && universalTemplateIDs.count == templateStats.count && !templateStats.isEmpty {
            stage = .universalReady
        } else if !failedTemplateIDs.isEmpty {
            stage = .blocked
        } else if completedRunCount > 0 {
            stage = .validating
        } else if activeBatch != nil || portfolioSummary.readyForSyntheticTrials {
            stage = .staged
        } else {
            stage = .awaitingCandidates
        }

        return CorrectionSyntheticTrialSummary(
            stage: stage,
            candidateTemplateCount: portfolioSummary.candidateTemplateCount,
            candidateTemplateIDs: candidateTemplateIDs,
            universalTemplateIDs: universalTemplateIDs,
            failedTemplateIDs: failedTemplateIDs,
            activeBatchID: activeBatch?.id,
            syntheticBotLabel: activeBatch?.botProfile.label,
            plannedRunCount: plannedRunCount,
            completedRunCount: completedRunCount,
            passedRunCount: passedRunCount,
            failedRunCount: failedRunCount)
    }

    public func diagnosisPortfolio(diagnosisID rawDiagnosisID: String) -> CorrectionDiagnosisPortfolioStats? {
        let diagnosisID = rawDiagnosisID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !diagnosisID.isEmpty else { return nil }

        var diagnosisLabel: String?
        var seenSubjectIDs = Set<String>()
        var activeSubjectIDs = Set<String>()
        var occurrenceCount = 0
        var resolvedCount = 0
        var failedCount = 0
        var rootCauseCounts: [String: Int] = [:]
        var templateLabels: [String: String] = [:]
        var templateSuccessCount: [String: Int] = [:]
        var templateFailureCount: [String: Int] = [:]
        var templateActiveCount: [String: Int] = [:]
        var templateSuccessfulSubjectIDs: [String: Set<String>] = [:]
        var templateFailedSubjectIDs: [String: Set<String>] = [:]

        for record in self.records {
            if let condition = record.conditions.first(where: { $0.diagnosisID == diagnosisID }) {
                seenSubjectIDs.insert(record.subjectID)
                occurrenceCount += condition.occurrenceCount
                resolvedCount += condition.successCount
                failedCount += condition.failureCount
                if diagnosisLabel == nil {
                    let label = condition.diagnosisLabel.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !label.isEmpty {
                        diagnosisLabel = label
                    }
                }
            }

            if record.currentDiagnosisID == diagnosisID {
                seenSubjectIDs.insert(record.subjectID)
                activeSubjectIDs.insert(record.subjectID)
            }

            for observation in record.observations where observation.diagnosisID == diagnosisID {
                seenSubjectIDs.insert(record.subjectID)
                if diagnosisLabel == nil {
                    let label = observation.diagnosisLabel.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !label.isEmpty {
                        diagnosisLabel = label
                    }
                }
                if let rootCause = observation.likelyRootCause?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !rootCause.isEmpty
                {
                    rootCauseCounts[rootCause, default: 0] += 1
                }
            }

            for treatment in record.treatments where treatment.diagnosisID == diagnosisID {
                seenSubjectIDs.insert(record.subjectID)
                if diagnosisLabel == nil {
                    let label = treatment.diagnosisLabel.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !label.isEmpty {
                        diagnosisLabel = label
                    }
                }

                guard let templateID = treatment.remedyTemplateID?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !templateID.isEmpty
                else {
                    continue
                }

                if let templateLabel = treatment.remedyTemplateLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !templateLabel.isEmpty
                {
                    templateLabels[templateID] = templateLabel
                }

                switch treatment.result {
                case .pending:
                    break
                case .resolved:
                    templateSuccessCount[templateID, default: 0] += 1
                    templateSuccessfulSubjectIDs[templateID, default: []].insert(record.subjectID)
                case .failed, .superseded:
                    templateFailureCount[templateID, default: 0] += 1
                    templateFailedSubjectIDs[templateID, default: []].insert(record.subjectID)
                }
            }
        }

        for activeCase in self.activeCases where activeCase.diagnosisID == diagnosisID {
            seenSubjectIDs.insert(activeCase.subjectID)
            activeSubjectIDs.insert(activeCase.subjectID)
            if diagnosisLabel == nil {
                let label = activeCase.diagnosisLabel.trimmingCharacters(in: .whitespacesAndNewlines)
                if !label.isEmpty {
                    diagnosisLabel = label
                }
            }
            guard let templateID = activeCase.remedyTemplateID?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !templateID.isEmpty
            else {
                continue
            }
            if let templateLabel = activeCase.remedyTemplateLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
               !templateLabel.isEmpty
            {
                templateLabels[templateID] = templateLabel
            }
            templateActiveCount[templateID, default: 0] += 1
        }

        guard !seenSubjectIDs.isEmpty else { return nil }

        let templateIDs = Set(templateLabels.keys)
            .union(templateSuccessCount.keys)
            .union(templateFailureCount.keys)
            .union(templateActiveCount.keys)
        let recommendations = templateIDs.map { templateID in
            CorrectionDiagnosisTemplateRecommendation(
                templateID: templateID,
                templateLabel: templateLabels[templateID] ?? templateID,
                successCount: templateSuccessCount[templateID, default: 0],
                failureCount: templateFailureCount[templateID, default: 0],
                activeCount: templateActiveCount[templateID, default: 0],
                successfulSubjectIDs: Array(templateSuccessfulSubjectIDs[templateID, default: []]).sorted(),
                failedSubjectIDs: Array(templateFailedSubjectIDs[templateID, default: []]).sorted())
        }
        .sorted { lhs, rhs in
            if lhs.stage.sortRank == rhs.stage.sortRank {
                if lhs.successfulBotCount == rhs.successfulBotCount {
                    if lhs.successCount == rhs.successCount {
                        if lhs.failureCount == rhs.failureCount {
                            return lhs.templateID < rhs.templateID
                        }
                        return lhs.failureCount < rhs.failureCount
                    }
                    return lhs.successCount > rhs.successCount
                }
                return lhs.successfulBotCount > rhs.successfulBotCount
            }
            return lhs.stage.sortRank > rhs.stage.sortRank
        }

        let rootCauses = rootCauseCounts.keys.sorted { lhs, rhs in
            let lhsCount = rootCauseCounts[lhs, default: 0]
            let rhsCount = rootCauseCounts[rhs, default: 0]
            if lhsCount == rhsCount {
                return lhs < rhs
            }
            return lhsCount > rhsCount
        }

        return CorrectionDiagnosisPortfolioStats(
            diagnosisID: diagnosisID,
            diagnosisLabel: diagnosisLabel ?? diagnosisID,
            seenSubjectIDs: Array(seenSubjectIDs).sorted(),
            activeSubjectIDs: Array(activeSubjectIDs).sorted(),
            occurrenceCount: occurrenceCount,
            resolvedCount: resolvedCount,
            failedCount: failedCount,
            leadingRootCauses: Array(rootCauses.prefix(3)),
            templateRecommendations: recommendations)
    }
}

public struct CorrectionTemplatePortfolioSummary: Sendable, Hashable {
    public let candidateTemplateCount: Int
    public let readyForSyntheticTrials: Bool
    public let candidateTemplateIDs: [String]

    public init(portfolios: [CorrectionTemplatePortfolioStats]) {
        let candidates = portfolios.filter(\.isCandidate)
        self.candidateTemplateCount = candidates.count
        self.readyForSyntheticTrials = candidates.count >= 3
        self.candidateTemplateIDs = candidates.map(\.templateID)
    }
}

public enum CorrectionSyntheticTrialResult: String, Codable, Sendable, Hashable {
    case pending
    case passed
    case failed
}

public struct CorrectionSyntheticBotProfile: Codable, Sendable, Hashable {
    public var id: String
    public var label: String
    public var persona: String
    public var specialty: String
    public var temperament: String
    public var createdAtMs: Int
    public var retiredAtMs: Int?

    public init(
        id: String,
        label: String,
        persona: String,
        specialty: String,
        temperament: String,
        createdAtMs: Int,
        retiredAtMs: Int? = nil)
    {
        self.id = id
        self.label = label
        self.persona = persona
        self.specialty = specialty
        self.temperament = temperament
        self.createdAtMs = createdAtMs
        self.retiredAtMs = retiredAtMs
    }
}

public struct CorrectionSyntheticTrialRun: Codable, Sendable, Identifiable, Hashable {
    public var id: String
    public var templateID: String
    public var templateLabel: String
    public var iteration: Int
    public var result: CorrectionSyntheticTrialResult
    public var scheduledAtMs: Int
    public var completedAtMs: Int?
    public var notes: String?

    public init(
        id: String,
        templateID: String,
        templateLabel: String,
        iteration: Int,
        result: CorrectionSyntheticTrialResult = .pending,
        scheduledAtMs: Int,
        completedAtMs: Int? = nil,
        notes: String? = nil)
    {
        self.id = id
        self.templateID = templateID
        self.templateLabel = templateLabel
        self.iteration = iteration
        self.result = result
        self.scheduledAtMs = scheduledAtMs
        self.completedAtMs = completedAtMs
        self.notes = notes
    }
}

public struct CorrectionSyntheticTrialBatch: Codable, Sendable, Identifiable, Hashable {
    public var id: String
    public var createdAtMs: Int
    public var candidateTemplateIDs: [String]
    public var botProfile: CorrectionSyntheticBotProfile
    public var runs: [CorrectionSyntheticTrialRun]
    public var completedAtMs: Int?

    public init(
        id: String,
        createdAtMs: Int,
        candidateTemplateIDs: [String],
        botProfile: CorrectionSyntheticBotProfile,
        runs: [CorrectionSyntheticTrialRun],
        completedAtMs: Int? = nil)
    {
        self.id = id
        self.createdAtMs = createdAtMs
        self.candidateTemplateIDs = candidateTemplateIDs
        self.botProfile = botProfile
        self.runs = runs
        self.completedAtMs = completedAtMs
    }
}

public struct CorrectionSyntheticTrialSummary: Sendable, Hashable {
    public enum Stage: String, Sendable, Hashable {
        case awaitingCandidates
        case staged
        case validating
        case blocked
        case universalReady
    }

    public let stage: Stage
    public let candidateTemplateCount: Int
    public let candidateTemplateIDs: [String]
    public let universalTemplateIDs: [String]
    public let failedTemplateIDs: [String]
    public let activeBatchID: String?
    public let syntheticBotLabel: String?
    public let plannedRunCount: Int
    public let completedRunCount: Int
    public let passedRunCount: Int
    public let failedRunCount: Int

    public init(
        stage: Stage,
        candidateTemplateCount: Int,
        candidateTemplateIDs: [String],
        universalTemplateIDs: [String],
        failedTemplateIDs: [String],
        activeBatchID: String?,
        syntheticBotLabel: String?,
        plannedRunCount: Int,
        completedRunCount: Int,
        passedRunCount: Int,
        failedRunCount: Int)
    {
        self.stage = stage
        self.candidateTemplateCount = candidateTemplateCount
        self.candidateTemplateIDs = candidateTemplateIDs
        self.universalTemplateIDs = universalTemplateIDs
        self.failedTemplateIDs = failedTemplateIDs
        self.activeBatchID = activeBatchID
        self.syntheticBotLabel = syntheticBotLabel
        self.plannedRunCount = plannedRunCount
        self.completedRunCount = completedRunCount
        self.passedRunCount = passedRunCount
        self.failedRunCount = failedRunCount
    }
}

public struct CorrectionSyntheticTrialExecutionPlan: Sendable, Hashable {
    public let batchID: String
    public let templateID: String
    public let templateLabel: String
    public let iteration: Int
    public let syntheticBotID: String
    public let syntheticBotLabel: String
    public let persona: String
    public let specialty: String
    public let temperament: String

    public init(
        batchID: String,
        templateID: String,
        templateLabel: String,
        iteration: Int,
        syntheticBotID: String,
        syntheticBotLabel: String,
        persona: String,
        specialty: String,
        temperament: String)
    {
        self.batchID = batchID
        self.templateID = templateID
        self.templateLabel = templateLabel
        self.iteration = iteration
        self.syntheticBotID = syntheticBotID
        self.syntheticBotLabel = syntheticBotLabel
        self.persona = persona
        self.specialty = specialty
        self.temperament = temperament
    }

    public var profileSummary: String {
        "\(self.syntheticBotLabel) is a \(self.persona) focused on \(self.specialty) work with a \(self.temperament) temperament."
    }
}

public struct CorrectionSyntheticTrialTemplateStats: Sendable, Hashable {
    public enum Stage: String, Sendable, Hashable {
        case queued
        case validating
        case failed
        case universal
    }

    public static let universalPassRequirement = 3

    public let templateID: String
    public let templateLabel: String
    public let syntheticBotLabel: String
    public let plannedRunCount: Int
    public let completedRunCount: Int
    public let passedRunCount: Int
    public let failedRunCount: Int
    public let pendingRunCount: Int

    public init(
        templateID: String,
        templateLabel: String,
        syntheticBotLabel: String,
        plannedRunCount: Int,
        completedRunCount: Int,
        passedRunCount: Int,
        failedRunCount: Int,
        pendingRunCount: Int)
    {
        self.templateID = templateID
        self.templateLabel = templateLabel
        self.syntheticBotLabel = syntheticBotLabel
        self.plannedRunCount = plannedRunCount
        self.completedRunCount = completedRunCount
        self.passedRunCount = passedRunCount
        self.failedRunCount = failedRunCount
        self.pendingRunCount = pendingRunCount
    }

    public var isUniversal: Bool {
        self.failedRunCount == 0 &&
            self.passedRunCount >= Self.universalPassRequirement &&
            self.pendingRunCount == 0
    }

    public var stage: Stage {
        if self.isUniversal {
            return .universal
        }
        if self.failedRunCount > 0 {
            return .failed
        }
        if self.completedRunCount > 0 {
            return .validating
        }
        return .queued
    }
}

public struct CorrectionDiagnosisPortfolioStats: Sendable, Hashable {
    public let diagnosisID: String
    public let diagnosisLabel: String
    public let seenSubjectIDs: [String]
    public let activeSubjectIDs: [String]
    public let occurrenceCount: Int
    public let resolvedCount: Int
    public let failedCount: Int
    public let leadingRootCauses: [String]
    public let templateRecommendations: [CorrectionDiagnosisTemplateRecommendation]

    public init(
        diagnosisID: String,
        diagnosisLabel: String,
        seenSubjectIDs: [String],
        activeSubjectIDs: [String],
        occurrenceCount: Int,
        resolvedCount: Int,
        failedCount: Int,
        leadingRootCauses: [String],
        templateRecommendations: [CorrectionDiagnosisTemplateRecommendation])
    {
        self.diagnosisID = diagnosisID
        self.diagnosisLabel = diagnosisLabel
        self.seenSubjectIDs = seenSubjectIDs
        self.activeSubjectIDs = activeSubjectIDs
        self.occurrenceCount = occurrenceCount
        self.resolvedCount = resolvedCount
        self.failedCount = failedCount
        self.leadingRootCauses = leadingRootCauses
        self.templateRecommendations = templateRecommendations
    }

    public var seenBotCount: Int {
        self.seenSubjectIDs.count
    }

    public var activeBotCount: Int {
        self.activeSubjectIDs.count
    }

    public var topRecommendation: CorrectionDiagnosisTemplateRecommendation? {
        self.templateRecommendations.first
    }
}

public struct CorrectionDiagnosisTemplateRecommendation: Sendable, Hashable {
    public enum Stage: String, Sendable, Hashable {
        case unproven
        case building
        case mixed
        case atRisk
        case recommended

        fileprivate var sortRank: Int {
            switch self {
            case .recommended: 5
            case .building: 4
            case .mixed: 3
            case .atRisk: 2
            case .unproven: 1
            }
        }
    }

    public static let recommendationSuccessRoundsRequirement = 2
    public static let recommendationSuccessfulBotsRequirement = 2

    public let templateID: String
    public let templateLabel: String
    public let successCount: Int
    public let failureCount: Int
    public let activeCount: Int
    public let successfulSubjectIDs: [String]
    public let failedSubjectIDs: [String]

    public init(
        templateID: String,
        templateLabel: String,
        successCount: Int,
        failureCount: Int,
        activeCount: Int,
        successfulSubjectIDs: [String],
        failedSubjectIDs: [String])
    {
        self.templateID = templateID
        self.templateLabel = templateLabel
        self.successCount = successCount
        self.failureCount = failureCount
        self.activeCount = activeCount
        self.successfulSubjectIDs = successfulSubjectIDs
        self.failedSubjectIDs = failedSubjectIDs
    }

    public var successfulBotCount: Int {
        self.successfulSubjectIDs.count
    }

    public var failedBotCount: Int {
        self.failedSubjectIDs.count
    }

    public var isRecommended: Bool {
        self.successCount >= Self.recommendationSuccessRoundsRequirement &&
            self.successfulBotCount >= Self.recommendationSuccessfulBotsRequirement &&
            self.failureCount == 0
    }

    public var stage: Stage {
        if self.isRecommended {
            return .recommended
        }
        if self.successCount == 0 && self.failureCount > 0 {
            return .atRisk
        }
        if self.successCount > 0 && self.failureCount > 0 {
            return .mixed
        }
        if self.successCount > 0 || self.activeCount > 0 {
            return .building
        }
        return .unproven
    }

    public var roundsRemainingForRecommendation: Int {
        max(0, Self.recommendationSuccessRoundsRequirement - self.successCount)
    }

    public var botsRemainingForRecommendation: Int {
        max(0, Self.recommendationSuccessfulBotsRequirement - self.successfulBotCount)
    }
}

public struct CorrectionTemplatePortfolioStats: Sendable, Hashable {
    public enum Stage: String, Sendable, Hashable {
        case unproven
        case building
        case mixed
        case atRisk
        case candidate

        fileprivate var sortRank: Int {
            switch self {
            case .candidate: 5
            case .building: 4
            case .mixed: 3
            case .atRisk: 2
            case .unproven: 1
            }
        }
    }

    public static let candidateSuccessRoundsRequirement = 3
    public static let candidateSuccessfulBotsRequirement = 3

    public let templateID: String
    public let templateLabel: String
    public let prescribedCount: Int
    public let successCount: Int
    public let failureCount: Int
    public let activeCount: Int
    public let successfulSubjectIDs: [String]
    public let failedSubjectIDs: [String]

    public init(
        templateID: String,
        templateLabel: String,
        prescribedCount: Int,
        successCount: Int,
        failureCount: Int,
        activeCount: Int,
        successfulSubjectIDs: [String],
        failedSubjectIDs: [String])
    {
        self.templateID = templateID
        self.templateLabel = templateLabel
        self.prescribedCount = prescribedCount
        self.successCount = successCount
        self.failureCount = failureCount
        self.activeCount = activeCount
        self.successfulSubjectIDs = successfulSubjectIDs
        self.failedSubjectIDs = failedSubjectIDs
    }

    public var successfulBotCount: Int {
        self.successfulSubjectIDs.count
    }

    public var failedBotCount: Int {
        self.failedSubjectIDs.count
    }

    public var totalResolvedRounds: Int {
        self.successCount + self.failureCount
    }

    public var isCandidate: Bool {
        self.successCount >= Self.candidateSuccessRoundsRequirement &&
            self.successfulBotCount >= Self.candidateSuccessfulBotsRequirement &&
            self.failureCount == 0
    }

    public var stage: Stage {
        if self.isCandidate {
            return .candidate
        }
        if self.successCount == 0 && self.failureCount > 0 {
            return .atRisk
        }
        if self.successCount > 0 && self.failureCount > 0 {
            return .mixed
        }
        if self.successCount > 0 || self.activeCount > 0 || self.prescribedCount > 0 {
            return .building
        }
        return .unproven
    }

    public var roundsRemainingForCandidate: Int {
        max(0, Self.candidateSuccessRoundsRequirement - self.successCount)
    }

    public var botsRemainingForCandidate: Int {
        max(0, Self.candidateSuccessfulBotsRequirement - self.successfulBotCount)
    }
}

public enum CorrectionCasebookStore {
    private static let fileName = "casebook.json"
    private static let maxObservationsPerRecord = 24
    private static let maxTreatmentsPerRecord = 24
    private static let syntheticTrialIterationsPerTemplate = 3

    public static func load() -> CorrectionCasebookSnapshot {
        self.readStore()
    }

    @discardableResult
    public static func recordSyntheticTrialOutcome(
        batchID rawBatchID: String,
        templateID rawTemplateID: String,
        iteration: Int,
        result: CorrectionSyntheticTrialResult,
        notes rawNotes: String? = nil,
        recordedAt: Date = Date()) -> CorrectionCasebookSnapshot
    {
        let batchID = self.sanitize(rawBatchID)
        let templateID = self.sanitize(rawTemplateID)
        guard !batchID.isEmpty,
              !templateID.isEmpty,
              iteration > 0
        else {
            return self.readStore()
        }

        var store = self.readStore()
        guard let batchIndex = store.syntheticTrials.firstIndex(where: { $0.id == batchID }),
              let runIndex = store.syntheticTrials[batchIndex].runs.firstIndex(where: {
                  $0.templateID == templateID && $0.iteration == iteration
              })
        else {
            return store
        }

        let recordedAtMs = self.timestampMs(recordedAt)
        store.syntheticTrials[batchIndex].runs[runIndex].result = result
        store.syntheticTrials[batchIndex].runs[runIndex].completedAtMs = recordedAtMs
        store.syntheticTrials[batchIndex].runs[runIndex].notes = self.optionalSanitize(rawNotes)
        if store.syntheticTrials[batchIndex].runs.allSatisfy({ $0.result != .pending }) {
            store.syntheticTrials[batchIndex].completedAtMs = recordedAtMs
            store.syntheticTrials[batchIndex].botProfile.retiredAtMs = recordedAtMs
        }
        store.updatedAtMs = recordedAtMs
        self.writeStore(store)
        return store
    }

    @discardableResult
    public static func recordOutcome(
        subjectID rawSubjectID: String,
        diagnosisID rawDiagnosisID: String,
        outcome: CorrectionOutcome,
        recordedAt: Date = Date()) -> CorrectionCasebookSnapshot
    {
        let subjectID = self.sanitize(rawSubjectID)
        let diagnosisID = self.sanitize(rawDiagnosisID)
        guard !subjectID.isEmpty, !diagnosisID.isEmpty else {
            return self.readStore()
        }

        var store = self.readStore()
        let key = self.activeKey(subjectID: subjectID, diagnosisID: diagnosisID)
        guard let activeIndex = store.activeCases.firstIndex(where: { $0.key == key }) else {
            return store
        }

        let observedAtMs = self.timestampMs(recordedAt)
        let active = store.activeCases.remove(at: activeIndex)
        guard let recordIndex = self.recordIndex(subjectID: active.subjectID, in: store),
              let conditionIndex = self.conditionIndex(
                  diagnosisID: active.diagnosisID,
                  in: store.records[recordIndex])
        else {
            store.updatedAtMs = observedAtMs
            self.writeStore(store)
            return store
        }

        store.records[recordIndex].updatedAtMs = observedAtMs
        store.records[recordIndex].conditions[conditionIndex].lastResolvedAtMs = observedAtMs
        store.records[recordIndex].conditions[conditionIndex].lastOutcome = outcome

        switch outcome {
        case .resolved:
            store.records[recordIndex].conditions[conditionIndex].successCount += 1
        case .failed, .superseded:
            store.records[recordIndex].conditions[conditionIndex].failureCount += 1
        }

        self.finishTreatment(
            recordIndex: recordIndex,
            treatmentID: active.treatmentRecordID,
            templateID: active.remedyTemplateID,
            result: self.treatmentResult(for: outcome),
            at: observedAtMs,
            in: &store)
        self.refreshCurrentMarkers(in: &store)
        store.activeCases.sort { lhs, rhs in
            if lhs.lastSeenAtMs == rhs.lastSeenAtMs {
                return lhs.key < rhs.key
            }
            return lhs.lastSeenAtMs > rhs.lastSeenAtMs
        }
        store.records.sort { lhs, rhs in
            if lhs.updatedAtMs == rhs.updatedAtMs {
                return lhs.subjectID < rhs.subjectID
            }
            return lhs.updatedAtMs > rhs.updatedAtMs
        }
        store.updatedAtMs = observedAtMs
        self.ensureSyntheticTrialPlan(in: &store, at: observedAtMs)
        self.writeStore(store)
        return store
    }

    @discardableResult
    public static func recordInterventionDispatch(
        subjectID rawSubjectID: String,
        diagnosisID rawDiagnosisID: String,
        summary rawSummary: String? = nil,
        recordedAt: Date = Date()) -> CorrectionCasebookSnapshot
    {
        let subjectID = self.sanitize(rawSubjectID)
        let diagnosisID = self.sanitize(rawDiagnosisID)
        guard !subjectID.isEmpty, !diagnosisID.isEmpty else {
            return self.readStore()
        }

        var store = self.readStore()
        let key = self.activeKey(subjectID: subjectID, diagnosisID: diagnosisID)
        guard let activeIndex = store.activeCases.firstIndex(where: { $0.key == key }) else {
            return store
        }

        let recordedAtMs = self.timestampMs(recordedAt)
        let dispatchEvidence = self.normalizeRuntimeEvidence(
            CorrectionRuntimeEvidence(
                interventionDispatchedAtMs: recordedAtMs,
                interventionDispatchSummary: rawSummary))

        guard let dispatchEvidence else {
            return store
        }

        let active = store.activeCases[activeIndex]
        store.activeCases[activeIndex].runtimeEvidence = self.mergedRuntimeEvidence(
            current: active.runtimeEvidence,
            incoming: dispatchEvidence)
        if let recordIndex = self.recordIndex(subjectID: subjectID, in: store) {
            store.records[recordIndex].updatedAtMs = recordedAtMs
            self.refreshPendingTreatment(
                runtimeEvidence: dispatchEvidence,
                recordIndex: recordIndex,
                treatmentID: active.treatmentRecordID,
                in: &store)
        }

        store.updatedAtMs = recordedAtMs
        self.writeStore(store)
        return store
    }

    @discardableResult
    public static func recordExternalResearch(
        subjectID rawSubjectID: String,
        diagnosisID rawDiagnosisID: String,
        query rawQuery: String? = nil,
        summary rawSummary: String? = nil,
        items rawItems: [CorrectionExternalResearchItem] = [],
        recordedAt: Date = Date()) -> CorrectionCasebookSnapshot
    {
        let subjectID = self.sanitize(rawSubjectID)
        let diagnosisID = self.sanitize(rawDiagnosisID)
        guard !subjectID.isEmpty, !diagnosisID.isEmpty else {
            return self.readStore()
        }

        var store = self.readStore()
        let key = self.activeKey(subjectID: subjectID, diagnosisID: diagnosisID)
        guard let activeIndex = store.activeCases.firstIndex(where: { $0.key == key }) else {
            return store
        }

        let recordedAtMs = self.timestampMs(recordedAt)
        let researchEvidence = self.normalizeRuntimeEvidence(
            CorrectionRuntimeEvidence(
                externalResearchFetchedAtMs: recordedAtMs,
                externalResearchQuery: rawQuery,
                externalResearchSummary: rawSummary,
                externalResearchItems: rawItems))

        guard let researchEvidence else {
            return store
        }

        let active = store.activeCases[activeIndex]
        store.activeCases[activeIndex].runtimeEvidence = self.mergedRuntimeEvidence(
            current: active.runtimeEvidence,
            incoming: researchEvidence)
        if let recordIndex = self.recordIndex(subjectID: subjectID, in: store) {
            store.records[recordIndex].updatedAtMs = recordedAtMs
            self.refreshPendingTreatment(
                runtimeEvidence: researchEvidence,
                recordIndex: recordIndex,
                treatmentID: active.treatmentRecordID,
                in: &store)
        }

        store.updatedAtMs = recordedAtMs
        self.writeStore(store)
        return store
    }

    @discardableResult
    public static func syncActiveCases(
        _ rawInputs: [CorrectionCaseInput],
        observedAt: Date = Date()) -> CorrectionCasebookSnapshot
    {
        var store = self.readStore()
        let observedAtMs = self.timestampMs(observedAt)
        let inputs = self.normalizedInputs(rawInputs)
        let activeSubjectIDs = Set(inputs.map(\.subjectID))
        let currentKeys = Set(inputs.map(self.activeKey(for:)))
        let previousActiveCases = store.activeCases
        var previousActiveByKey = Dictionary(uniqueKeysWithValues: previousActiveCases.map { ($0.key, $0) })
        var nextActiveCases: [CorrectionActiveCase] = []

        for input in inputs {
            let key = self.activeKey(for: input)
            let recordIndex = self.recordIndex(for: input, observedAtMs: observedAtMs, in: &store)
            let conditionIndex = self.conditionIndex(for: input, in: &store.records[recordIndex])
            let previousActive = previousActiveByKey.removeValue(forKey: key)

            if let previousActive {
                let runtimeEvidence = self.mergedRuntimeEvidence(
                    current: previousActive.runtimeEvidence,
                    incoming: input.runtimeEvidence)
                if previousActive.fingerprint == input.fingerprint {
                    store.records[recordIndex].updatedAtMs = observedAtMs
                    store.records[recordIndex].conditions[conditionIndex].lastSeenAtMs = observedAtMs
                    let effectiveInput = self.input(input, runtimeEvidence: runtimeEvidence)
                    self.captureReferenceMetadata(
                        effectiveInput,
                        recordIndex: recordIndex,
                        conditionIndex: conditionIndex,
                        in: &store)
                    self.refreshObservation(
                        from: effectiveInput,
                        recordIndex: recordIndex,
                        observedAtMs: observedAtMs,
                        in: &store)
                    self.refreshPendingTreatment(
                        from: effectiveInput,
                        recordIndex: recordIndex,
                        treatmentID: previousActive.treatmentRecordID,
                        in: &store)
                    nextActiveCases.append(
                        CorrectionActiveCase(
                            key: key,
                            subjectID: input.subjectID,
                            diagnosisID: input.diagnosisID,
                            diagnosisLabel: input.diagnosisLabel,
                            fingerprint: input.fingerprint,
                            firstSeenAtMs: previousActive.firstSeenAtMs,
                            lastSeenAtMs: observedAtMs,
                            treatmentRecordID: previousActive.treatmentRecordID,
                            prescriptionLine: input.prescriptionLine,
                            remedyTemplateID: input.remedyTemplateID,
                            remedyTemplateLabel: input.remedyTemplateLabel,
                            runtimeEvidence: runtimeEvidence))
                    continue
                }

                self.finishTreatment(
                    recordIndex: recordIndex,
                    treatmentID: previousActive.treatmentRecordID,
                    templateID: previousActive.remedyTemplateID,
                    result: .failed,
                    at: observedAtMs,
                    in: &store)
                store.records[recordIndex].conditions[conditionIndex].failureCount += 1
                store.records[recordIndex].conditions[conditionIndex].lastResolvedAtMs = observedAtMs
                store.records[recordIndex].conditions[conditionIndex].lastOutcome = .failed
            } else {
                store.records[recordIndex].conditions[conditionIndex].occurrenceCount += 1
            }

            store.records[recordIndex].conditions[conditionIndex].lastSeenAtMs = observedAtMs
                self.captureReferenceMetadata(input, recordIndex: recordIndex, conditionIndex: conditionIndex, in: &store)

            self.appendObservation(
                from: input,
                recordIndex: recordIndex,
                observedAtMs: observedAtMs,
                in: &store)
            let treatmentID = self.appendTreatment(
                from: input,
                recordIndex: recordIndex,
                prescribedAtMs: observedAtMs,
                in: &store)
            nextActiveCases.append(
                CorrectionActiveCase(
                    key: key,
                    subjectID: input.subjectID,
                    diagnosisID: input.diagnosisID,
                    diagnosisLabel: input.diagnosisLabel,
                    fingerprint: input.fingerprint,
                    firstSeenAtMs: previousActive?.firstSeenAtMs ?? observedAtMs,
                    lastSeenAtMs: observedAtMs,
                    treatmentRecordID: treatmentID,
                    prescriptionLine: input.prescriptionLine,
                    remedyTemplateID: input.remedyTemplateID,
                    remedyTemplateLabel: input.remedyTemplateLabel,
                    runtimeEvidence: input.runtimeEvidence))
        }

        for previousActive in previousActiveCases where !currentKeys.contains(previousActive.key) {
            let subjectStillActive = activeSubjectIDs.contains(previousActive.subjectID)
            guard let recordIndex = self.recordIndex(subjectID: previousActive.subjectID, in: store) else { continue }
            guard let conditionIndex = self.conditionIndex(
                diagnosisID: previousActive.diagnosisID,
                in: store.records[recordIndex])
            else {
                continue
            }
            store.records[recordIndex].updatedAtMs = observedAtMs
            store.records[recordIndex].conditions[conditionIndex].lastResolvedAtMs = observedAtMs
            if subjectStillActive {
                store.records[recordIndex].conditions[conditionIndex].failureCount += 1
                store.records[recordIndex].conditions[conditionIndex].lastOutcome = .superseded
                self.finishTreatment(
                    recordIndex: recordIndex,
                    treatmentID: previousActive.treatmentRecordID,
                    templateID: previousActive.remedyTemplateID,
                    result: .superseded,
                    at: observedAtMs,
                    in: &store)
            } else {
                store.records[recordIndex].conditions[conditionIndex].successCount += 1
                store.records[recordIndex].conditions[conditionIndex].lastOutcome = .resolved
                self.finishTreatment(
                    recordIndex: recordIndex,
                    treatmentID: previousActive.treatmentRecordID,
                    templateID: previousActive.remedyTemplateID,
                    result: .resolved,
                    at: observedAtMs,
                    in: &store)
            }
        }

        store.activeCases = nextActiveCases.sorted { lhs, rhs in
            if lhs.lastSeenAtMs == rhs.lastSeenAtMs {
                return lhs.key < rhs.key
            }
            return lhs.lastSeenAtMs > rhs.lastSeenAtMs
        }
        self.refreshCurrentMarkers(in: &store)
        store.records.sort { lhs, rhs in
            if lhs.updatedAtMs == rhs.updatedAtMs {
                return lhs.subjectID < rhs.subjectID
            }
            return lhs.updatedAtMs > rhs.updatedAtMs
        }
        store.updatedAtMs = observedAtMs
        self.ensureSyntheticTrialPlan(in: &store, at: observedAtMs)
        self.writeStore(store)
        return store
    }

    @discardableResult
    public static func syncSyntheticTrials(createdAt: Date = Date()) -> CorrectionCasebookSnapshot {
        var store = self.readStore()
        let createdAtMs = self.timestampMs(createdAt)
        self.ensureSyntheticTrialPlan(in: &store, at: createdAtMs)
        store.updatedAtMs = max(store.updatedAtMs ?? createdAtMs, createdAtMs)
        self.writeStore(store)
        return store
    }

    private static func normalizedInputs(_ inputs: [CorrectionCaseInput]) -> [CorrectionCaseInput] {
        var ordered: [CorrectionCaseInput] = []
        var seenKeys = Set<String>()
        for input in inputs {
            let normalized = self.normalize(input)
            guard !normalized.subjectID.isEmpty, !normalized.diagnosisID.isEmpty, !normalized.fingerprint.isEmpty else {
                continue
            }
            let key = self.activeKey(for: normalized)
            guard !seenKeys.contains(key) else { continue }
            seenKeys.insert(key)
            ordered.append(normalized)
        }
        return ordered.sorted { lhs, rhs in
            let lhsKey = self.activeKey(for: lhs)
            let rhsKey = self.activeKey(for: rhs)
            return lhsKey < rhsKey
        }
    }

    private static func normalize(_ input: CorrectionCaseInput) -> CorrectionCaseInput {
        CorrectionCaseInput(
            subjectID: self.sanitize(input.subjectID),
            subjectLabel: self.sanitize(input.subjectLabel),
            role: self.sanitize(input.role),
            diagnosisID: self.sanitize(input.diagnosisID),
            diagnosisLabel: self.sanitize(input.diagnosisLabel),
            severity: self.sanitize(input.severity),
            summary: self.sanitize(input.summary),
            evidence: input.evidence.map(self.sanitize).filter { !$0.isEmpty },
            prescriptionLine: self.sanitize(input.prescriptionLine),
            remedyTemplateID: self.optionalSanitize(input.remedyTemplateID),
            remedyTemplateLabel: self.optionalSanitize(input.remedyTemplateLabel),
            likelyRootCause: self.optionalSanitize(input.likelyRootCause),
            runtimeEvidence: self.normalizeRuntimeEvidence(input.runtimeEvidence),
            fingerprint: self.sanitize(input.fingerprint))
    }

    private static func ensureSyntheticTrialPlan(in store: inout CorrectionCasebookSnapshot, at observedAtMs: Int) {
        let candidatePortfolios = store.templatePortfolio().filter(\.isCandidate)
        guard candidatePortfolios.count >= 3 else { return }

        let candidateTemplateIDs = candidatePortfolios.map(\.templateID).sorted()
        if store.syntheticTrials.contains(where: {
            $0.candidateTemplateIDs.sorted() == candidateTemplateIDs
        }) {
            return
        }

        let batchID = UUID().uuidString.lowercased()
        let botProfile = self.syntheticBotProfile(candidateTemplateIDs: candidateTemplateIDs, createdAtMs: observedAtMs)
        let runs = candidatePortfolios
            .sorted { $0.templateID < $1.templateID }
            .flatMap { portfolio in
                (1...self.syntheticTrialIterationsPerTemplate).map { iteration in
                    CorrectionSyntheticTrialRun(
                        id: UUID().uuidString.lowercased(),
                        templateID: portfolio.templateID,
                        templateLabel: portfolio.templateLabel,
                        iteration: iteration,
                        scheduledAtMs: observedAtMs)
                }
            }

        store.syntheticTrials.append(
            CorrectionSyntheticTrialBatch(
                id: batchID,
                createdAtMs: observedAtMs,
                candidateTemplateIDs: candidateTemplateIDs,
                botProfile: botProfile,
                runs: runs))
        store.syntheticTrials.sort { lhs, rhs in
            if lhs.completedAtMs == rhs.completedAtMs {
                return lhs.createdAtMs > rhs.createdAtMs
            }
            if lhs.completedAtMs == nil {
                return true
            }
            if rhs.completedAtMs == nil {
                return false
            }
            return (lhs.completedAtMs ?? lhs.createdAtMs) > (rhs.completedAtMs ?? rhs.createdAtMs)
        }
    }

    private static func syntheticBotProfile(candidateTemplateIDs: [String], createdAtMs: Int) -> CorrectionSyntheticBotProfile {
        let codenames = ["Sable", "Quartz", "Harbor", "Juniper", "Mistral", "Atlas"]
        let personas = [
            "fast but distractible execution bot",
            "careful but over-verbose analyst bot",
            "confident but shortcut-prone operator bot",
            "high-agency but evidence-thin planner bot",
        ]
        let specialties = ["research", "delivery", "triage", "ops", "design", "support"]
        let temperaments = ["minimalist", "restless", "literal", "overconfident", "perfectionist", "chatty"]
        let seed = abs(candidateTemplateIDs.joined(separator: "|").hashValue ^ createdAtMs.hashValue)
        let codename = codenames[seed % codenames.count]
        let persona = personas[seed % personas.count]
        let specialty = specialties[seed % specialties.count]
        let temperament = temperaments[seed % temperaments.count]
        return CorrectionSyntheticBotProfile(
            id: "synthetic-bot-\(UUID().uuidString.lowercased())",
            label: "Synthetic \(codename)",
            persona: persona,
            specialty: specialty,
            temperament: temperament,
            createdAtMs: createdAtMs)
    }

    private static func refreshCurrentMarkers(in store: inout CorrectionCasebookSnapshot) {
        let activeBySubject = Dictionary(grouping: store.activeCases, by: \.subjectID)
        for index in store.records.indices {
            if let current = activeBySubject[store.records[index].subjectID]?.max(by: { $0.lastSeenAtMs < $1.lastSeenAtMs }) {
                store.records[index].currentDiagnosisID = current.diagnosisID
                store.records[index].currentTreatmentTemplateID = current.remedyTemplateID
            } else {
                store.records[index].currentDiagnosisID = nil
                store.records[index].currentTreatmentTemplateID = nil
            }
        }
    }

    private static func captureReferenceMetadata(
        _ input: CorrectionCaseInput,
        recordIndex: Int,
        conditionIndex: Int,
        in store: inout CorrectionCasebookSnapshot)
    {
        store.records[recordIndex].conditions[conditionIndex].lastPrescriptionLine = input.prescriptionLine
        store.records[recordIndex].conditions[conditionIndex].lastRootCause = self.optionalSanitize(input.likelyRootCause) ?? ""
    }

    @discardableResult
    private static func appendTreatment(
        from input: CorrectionCaseInput,
        recordIndex: Int,
        prescribedAtMs: Int,
        in store: inout CorrectionCasebookSnapshot) -> String
    {
        let treatmentID = UUID().uuidString.lowercased()
        store.records[recordIndex].treatments.append(
            CorrectionTreatmentRecord(
                id: treatmentID,
                diagnosisID: input.diagnosisID,
                diagnosisLabel: input.diagnosisLabel,
                remedyTemplateID: input.remedyTemplateID,
                remedyTemplateLabel: input.remedyTemplateLabel,
                prescribedAtMs: prescribedAtMs,
                resolvedAtMs: nil,
                result: .pending,
                prescriptionLine: input.prescriptionLine,
                likelyRootCause: input.likelyRootCause,
                runtimeEvidence: input.runtimeEvidence,
                fingerprint: input.fingerprint))
        self.trimTreatments(recordIndex: recordIndex, in: &store)
        if let templateIndex = self.templateIndex(for: input, in: &store.records[recordIndex]) {
            store.records[recordIndex].templates[templateIndex].prescribedCount += 1
            store.records[recordIndex].templates[templateIndex].lastUsedAtMs = prescribedAtMs
        }
        return treatmentID
    }

    private static func appendObservation(
        from input: CorrectionCaseInput,
        recordIndex: Int,
        observedAtMs: Int,
        in store: inout CorrectionCasebookSnapshot)
    {
        store.records[recordIndex].observations.append(
            CorrectionObservation(
                id: UUID().uuidString.lowercased(),
                observedAtMs: observedAtMs,
                diagnosisID: input.diagnosisID,
                diagnosisLabel: input.diagnosisLabel,
                severity: input.severity,
                summary: input.summary,
                evidence: input.evidence,
                prescriptionLine: input.prescriptionLine,
                remedyTemplateID: input.remedyTemplateID,
                remedyTemplateLabel: input.remedyTemplateLabel,
                likelyRootCause: input.likelyRootCause,
                runtimeEvidence: input.runtimeEvidence,
                fingerprint: input.fingerprint))
        self.trimObservations(recordIndex: recordIndex, in: &store)
    }

    private static func refreshObservation(
        from input: CorrectionCaseInput,
        recordIndex: Int,
        observedAtMs: Int,
        in store: inout CorrectionCasebookSnapshot)
    {
        guard let observationIndex = store.records[recordIndex].observations.lastIndex(where: {
            $0.diagnosisID == input.diagnosisID && $0.fingerprint == input.fingerprint
        }) else {
            self.appendObservation(from: input, recordIndex: recordIndex, observedAtMs: observedAtMs, in: &store)
            return
        }

        store.records[recordIndex].observations[observationIndex].observedAtMs = observedAtMs
        store.records[recordIndex].observations[observationIndex].diagnosisLabel = input.diagnosisLabel
        store.records[recordIndex].observations[observationIndex].severity = input.severity
        store.records[recordIndex].observations[observationIndex].summary = input.summary
        store.records[recordIndex].observations[observationIndex].evidence = input.evidence
        store.records[recordIndex].observations[observationIndex].prescriptionLine = input.prescriptionLine
        store.records[recordIndex].observations[observationIndex].remedyTemplateID = input.remedyTemplateID
        store.records[recordIndex].observations[observationIndex].remedyTemplateLabel = input.remedyTemplateLabel
        store.records[recordIndex].observations[observationIndex].likelyRootCause = input.likelyRootCause
        store.records[recordIndex].observations[observationIndex].runtimeEvidence = input.runtimeEvidence
    }

    private static func refreshPendingTreatment(
        from input: CorrectionCaseInput,
        recordIndex: Int,
        treatmentID: String,
        in store: inout CorrectionCasebookSnapshot)
    {
        guard let treatmentIndex = store.records[recordIndex].treatments.firstIndex(where: { $0.id == treatmentID }) else {
            return
        }

        store.records[recordIndex].treatments[treatmentIndex].diagnosisLabel = input.diagnosisLabel
        store.records[recordIndex].treatments[treatmentIndex].remedyTemplateID = input.remedyTemplateID
        store.records[recordIndex].treatments[treatmentIndex].remedyTemplateLabel = input.remedyTemplateLabel
        store.records[recordIndex].treatments[treatmentIndex].prescriptionLine = input.prescriptionLine
        store.records[recordIndex].treatments[treatmentIndex].likelyRootCause = input.likelyRootCause
        store.records[recordIndex].treatments[treatmentIndex].fingerprint = input.fingerprint
        if let runtimeEvidence = input.runtimeEvidence {
            store.records[recordIndex].treatments[treatmentIndex].runtimeEvidence = runtimeEvidence
        }
    }

    private static func refreshPendingTreatment(
        runtimeEvidence: CorrectionRuntimeEvidence,
        recordIndex: Int,
        treatmentID: String,
        in store: inout CorrectionCasebookSnapshot)
    {
        guard let treatmentIndex = store.records[recordIndex].treatments.firstIndex(where: { $0.id == treatmentID }) else {
            return
        }

        store.records[recordIndex].treatments[treatmentIndex].runtimeEvidence = self.mergedRuntimeEvidence(
            current: store.records[recordIndex].treatments[treatmentIndex].runtimeEvidence,
            incoming: runtimeEvidence)
    }

    private static func finishTreatment(
        recordIndex: Int,
        treatmentID: String,
        templateID: String?,
        result: CorrectionTreatmentResult,
        at observedAtMs: Int,
        in store: inout CorrectionCasebookSnapshot)
    {
        if let treatmentIndex = store.records[recordIndex].treatments.firstIndex(where: { $0.id == treatmentID }) {
            store.records[recordIndex].treatments[treatmentIndex].result = result
            store.records[recordIndex].treatments[treatmentIndex].resolvedAtMs = observedAtMs
        }
        guard let templateID = self.optionalSanitize(templateID),
              let templateIndex = self.templateIndex(templateID: templateID, in: store.records[recordIndex])
        else {
            return
        }
        switch result {
        case .resolved:
            store.records[recordIndex].templates[templateIndex].successCount += 1
        case .failed, .superseded:
            store.records[recordIndex].templates[templateIndex].failureCount += 1
        case .pending:
            break
        }
        store.records[recordIndex].templates[templateIndex].lastUsedAtMs = observedAtMs
    }

    private static func recordIndex(
        for input: CorrectionCaseInput,
        observedAtMs: Int,
        in store: inout CorrectionCasebookSnapshot) -> Int
    {
        if let index = self.recordIndex(subjectID: input.subjectID, in: store) {
            store.records[index].label = input.subjectLabel
            store.records[index].role = input.role
            store.records[index].updatedAtMs = observedAtMs
            return index
        }
        store.records.append(
            BotMedicalRecord(
                subjectID: input.subjectID,
                label: input.subjectLabel,
                role: input.role,
                createdAtMs: observedAtMs,
                updatedAtMs: observedAtMs))
        return store.records.count - 1
    }

    private static func recordIndex(subjectID: String, in store: CorrectionCasebookSnapshot) -> Int? {
        store.records.firstIndex { $0.subjectID == subjectID }
    }

    private static func conditionIndex(for input: CorrectionCaseInput, in record: inout BotMedicalRecord) -> Int {
        if let index = self.conditionIndex(diagnosisID: input.diagnosisID, in: record) {
            record.conditions[index].diagnosisLabel = input.diagnosisLabel
            return index
        }
        record.conditions.append(
            CorrectionConditionStats(
                diagnosisID: input.diagnosisID,
                diagnosisLabel: input.diagnosisLabel))
        return record.conditions.count - 1
    }

    private static func conditionIndex(diagnosisID: String, in record: BotMedicalRecord) -> Int? {
        record.conditions.firstIndex { $0.diagnosisID == diagnosisID }
    }

    private static func templateIndex(for input: CorrectionCaseInput, in record: inout BotMedicalRecord) -> Int? {
        guard let templateID = self.optionalSanitize(input.remedyTemplateID) else { return nil }
        if let index = self.templateIndex(templateID: templateID, in: record) {
            if let templateLabel = self.optionalSanitize(input.remedyTemplateLabel) {
                record.templates[index].templateLabel = templateLabel
            }
            return index
        }
        record.templates.append(
            CorrectionTemplateStats(
                templateID: templateID,
                templateLabel: self.optionalSanitize(input.remedyTemplateLabel) ?? templateID))
        return record.templates.count - 1
    }

    private static func templateIndex(templateID: String, in record: BotMedicalRecord) -> Int? {
        record.templates.firstIndex { $0.templateID == templateID }
    }

    private static func trimObservations(recordIndex: Int, in store: inout CorrectionCasebookSnapshot) {
        let overflow = store.records[recordIndex].observations.count - self.maxObservationsPerRecord
        if overflow > 0 {
            store.records[recordIndex].observations.removeFirst(overflow)
        }
    }

    private static func trimTreatments(recordIndex: Int, in store: inout CorrectionCasebookSnapshot) {
        let overflow = store.records[recordIndex].treatments.count - self.maxTreatmentsPerRecord
        if overflow > 0 {
            store.records[recordIndex].treatments.removeFirst(overflow)
        }
    }

    private static func activeKey(for input: CorrectionCaseInput) -> String {
        self.activeKey(subjectID: input.subjectID, diagnosisID: input.diagnosisID)
    }

    private static func activeKey(subjectID: String, diagnosisID: String) -> String {
        "\(subjectID)::\(diagnosisID)"
    }

    private static func treatmentResult(for outcome: CorrectionOutcome) -> CorrectionTreatmentResult {
        switch outcome {
        case .resolved:
            .resolved
        case .failed:
            .failed
        case .superseded:
            .superseded
        }
    }

    private static func timestampMs(_ date: Date) -> Int {
        Int(date.timeIntervalSince1970 * 1000)
    }

    private static func sanitize(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func optionalSanitize(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = self.sanitize(value)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func normalizeRuntimeEvidence(_ value: CorrectionRuntimeEvidence?) -> CorrectionRuntimeEvidence? {
        guard let value else { return nil }

        let normalized = CorrectionRuntimeEvidence(
            assistantOutputAtMs: value.assistantOutputAtMs.flatMap { $0 > 0 ? $0 : nil },
            assistantOutputSummary: self.optionalSanitize(value.assistantOutputSummary),
            assistantOutputHasArtifact: value.assistantOutputHasArtifact,
            outputAfterRoundStart: value.outputAfterRoundStart,
            interventionDispatchedAtMs: value.interventionDispatchedAtMs.flatMap { $0 > 0 ? $0 : nil },
            interventionDispatchSummary: self.optionalSanitize(value.interventionDispatchSummary),
            externalResearchFetchedAtMs: value.externalResearchFetchedAtMs.flatMap { $0 > 0 ? $0 : nil },
            externalResearchQuery: self.optionalSanitize(value.externalResearchQuery),
            externalResearchSummary: self.optionalSanitize(value.externalResearchSummary),
            externalResearchItems: self.normalizeExternalResearchItems(value.externalResearchItems))

        if normalized.assistantOutputAtMs == nil,
           normalized.assistantOutputSummary == nil,
           normalized.assistantOutputHasArtifact == nil,
           normalized.outputAfterRoundStart == nil,
           normalized.interventionDispatchedAtMs == nil,
           normalized.interventionDispatchSummary == nil,
           normalized.externalResearchFetchedAtMs == nil,
           normalized.externalResearchQuery == nil,
           normalized.externalResearchSummary == nil,
           normalized.externalResearchItems.isEmpty
        {
            return nil
        }
        return normalized
    }

    private static func mergedRuntimeEvidence(
        current: CorrectionRuntimeEvidence?,
        incoming: CorrectionRuntimeEvidence?) -> CorrectionRuntimeEvidence?
    {
        let normalizedCurrent = self.normalizeRuntimeEvidence(current)
        let normalizedIncoming = self.normalizeRuntimeEvidence(incoming)
        guard normalizedCurrent != nil || normalizedIncoming != nil else {
            return nil
        }

        let incomingTouchesExternalResearch =
            normalizedIncoming?.externalResearchFetchedAtMs != nil
            || normalizedIncoming?.externalResearchQuery != nil
            || normalizedIncoming?.externalResearchSummary != nil
            || normalizedIncoming?.externalResearchItems.isEmpty == false

        return self.normalizeRuntimeEvidence(
            CorrectionRuntimeEvidence(
                assistantOutputAtMs: normalizedIncoming?.assistantOutputAtMs ?? normalizedCurrent?.assistantOutputAtMs,
                assistantOutputSummary: normalizedIncoming?.assistantOutputSummary ?? normalizedCurrent?.assistantOutputSummary,
                assistantOutputHasArtifact: normalizedIncoming?.assistantOutputHasArtifact ?? normalizedCurrent?.assistantOutputHasArtifact,
                outputAfterRoundStart: normalizedIncoming?.outputAfterRoundStart ?? normalizedCurrent?.outputAfterRoundStart,
                interventionDispatchedAtMs: normalizedIncoming?.interventionDispatchedAtMs ?? normalizedCurrent?.interventionDispatchedAtMs,
                interventionDispatchSummary: normalizedIncoming?.interventionDispatchSummary ?? normalizedCurrent?.interventionDispatchSummary,
                externalResearchFetchedAtMs: incomingTouchesExternalResearch
                    ? normalizedIncoming?.externalResearchFetchedAtMs
                    : normalizedCurrent?.externalResearchFetchedAtMs,
                externalResearchQuery: incomingTouchesExternalResearch
                    ? normalizedIncoming?.externalResearchQuery
                    : normalizedCurrent?.externalResearchQuery,
                externalResearchSummary: incomingTouchesExternalResearch
                    ? normalizedIncoming?.externalResearchSummary
                    : normalizedCurrent?.externalResearchSummary,
                externalResearchItems: incomingTouchesExternalResearch
                    ? (normalizedIncoming?.externalResearchItems ?? [])
                    : (normalizedCurrent?.externalResearchItems ?? [])))
    }

    private static func normalizeExternalResearchItems(
        _ items: [CorrectionExternalResearchItem]) -> [CorrectionExternalResearchItem]
    {
        var seenURLs: Set<String> = []
        var normalized: [CorrectionExternalResearchItem] = []

        for item in items {
            let title = self.sanitize(item.title)
            let url = self.sanitize(item.url)
            guard !title.isEmpty, !url.isEmpty else { continue }
            let dedupeKey = url.lowercased()
            guard seenURLs.insert(dedupeKey).inserted else { continue }
            normalized.append(
                CorrectionExternalResearchItem(
                    title: title,
                    url: url,
                    source: self.optionalSanitize(item.source) ?? "Web",
                    snippet: self.optionalSanitize(item.snippet) ?? ""))
        }

        return normalized
    }

    private static func input(
        _ input: CorrectionCaseInput,
        runtimeEvidence: CorrectionRuntimeEvidence?) -> CorrectionCaseInput
    {
        CorrectionCaseInput(
            subjectID: input.subjectID,
            subjectLabel: input.subjectLabel,
            role: input.role,
            diagnosisID: input.diagnosisID,
            diagnosisLabel: input.diagnosisLabel,
            severity: input.severity,
            summary: input.summary,
            evidence: input.evidence,
            prescriptionLine: input.prescriptionLine,
            remedyTemplateID: input.remedyTemplateID,
            remedyTemplateLabel: input.remedyTemplateLabel,
            likelyRootCause: input.likelyRootCause,
            runtimeEvidence: runtimeEvidence,
            fingerprint: input.fingerprint)
    }

    private static func readStore() -> CorrectionCasebookSnapshot {
        let url = self.fileURL()
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(CorrectionCasebookSnapshot.self, from: data),
              decoded.version >= 1,
              decoded.version <= CorrectionCasebookSnapshot.currentVersion
        else {
            return CorrectionCasebookSnapshot()
        }
        return decoded
    }

    private static func writeStore(_ store: CorrectionCasebookSnapshot) {
        let url = self.fileURL()
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(store)
            try data.write(to: url, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            // best-effort only
        }
    }

    private static func fileURL() -> URL {
        DeviceIdentityPaths.stateDirURL()
            .appendingPathComponent("correction", isDirectory: true)
            .appendingPathComponent(self.fileName, isDirectory: false)
    }
}
