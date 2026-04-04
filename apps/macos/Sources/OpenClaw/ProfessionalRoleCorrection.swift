import Foundation

struct ProfessionalRoleContract: Equatable, Hashable, Sendable {
    let id: String
    let title: String
    let summary: String
    let mission: String
    let behavioralConstitution: [String]
    let evidenceObligations: [String]
    let escalationRules: [String]
    let sourceLabel: String
}

struct ProfessionalRoleDriftAssessment: Equatable, Hashable, Sendable {
    let title: String
    let detail: String
    let highlights: [String]
    let systemImage: String
}

struct ProfessionalRoleAssessment: Equatable, Hashable, Sendable {
    let contract: ProfessionalRoleContract
    let drift: ProfessionalRoleDriftAssessment
}

struct WorkspaceProfessionalConstitution: Equatable, Sendable {
    let name: String?
    let seat: String?
    let department: String?
    let role: String?
    let mission: String?
    let nonNegotiables: [String]
    let defaultOutputs: [String]

    var sourceLabel: String {
        let parts = [self.name, self.role, self.department].compactMap { $0?.nonEmpty }
        guard !parts.isEmpty else {
            return "Workspace constitution from IDENTITY.md and SOUL.md"
        }
        return "Workspace constitution from " + parts.joined(separator: " / ")
    }
}

enum ProfessionalRoleCorrection {
    enum DriftCategory {
        case evidenceBoundary
        case executionDiscipline
        case guardrail
        case escalationEtiquette
        case scopeDiscipline
    }

    private struct IssueContext {
        let seat: String
        let subjectRole: String
        let title: String
        let subtitle: String
        let diagnosisID: String
        let diagnosis: String
        let prescription: String
        let evidence: [String]
        let likelyRootCause: String?
    }

    static func assessment(for issue: CorrectionWorkspaceIssue) -> ProfessionalRoleAssessment {
        self.assessment(
            seat: issue.seat,
            subjectRole: issue.subjectRole,
            title: issue.title,
            subtitle: issue.subtitle,
            diagnosisID: issue.diagnosisID,
            diagnosis: issue.diagnosis,
            prescription: issue.prescription,
            evidence: issue.evidence,
            likelyRootCause: issue.likelyRootCause)
    }

    static func assessment(
        seat: String,
        subjectRole: String,
        title: String,
        subtitle: String,
        diagnosisID: String,
        diagnosis: String,
        prescription: String,
        evidence: [String],
        likelyRootCause: String?) -> ProfessionalRoleAssessment
    {
        let context = IssueContext(
            seat: seat,
            subjectRole: subjectRole,
            title: title,
            subtitle: subtitle,
            diagnosisID: diagnosisID,
            diagnosis: diagnosis,
            prescription: prescription,
            evidence: evidence,
            likelyRootCause: likelyRootCause)
        let constitution = self.workspaceConstitution()
        let contract = self.contract(for: context, constitution: constitution)
        let drift = self.driftAssessment(for: context, contract: contract)
        return ProfessionalRoleAssessment(contract: contract, drift: drift)
    }

    static func workspaceConstitution(documentRoot: URL? = nil) -> WorkspaceProfessionalConstitution? {
        let roots = documentRoot.map { [$0] } ?? self.candidateDocumentRoots()
        for root in roots {
            guard let identityContent = self.document(named: "IDENTITY.md", in: root) else {
                continue
            }
            let identityFields = self.parseMarkdownFields(identityContent)
            let soulContent = self.document(named: "SOUL.md", in: root) ?? ""
            let nonNegotiables = self.markdownBulletItems(in: soulContent, under: "your non-negotiables")
            let outputs = self.markdownBulletItems(in: identityContent, under: "default outputs")
            let constitution = WorkspaceProfessionalConstitution(
                name: identityFields["name"],
                seat: identityFields["seat"],
                department: identityFields["department"],
                role: identityFields["role"],
                mission: identityFields["mission"],
                nonNegotiables: nonNegotiables,
                defaultOutputs: outputs)
            if constitution.name != nil
                || constitution.role != nil
                || constitution.mission != nil
                || !constitution.nonNegotiables.isEmpty
            {
                return constitution
            }
        }
        return nil
    }

    static func inferRoleKey(
        seat: String,
        subjectRole: String,
        diagnosisID: String,
        diagnosis: String,
        evidence: [String],
        likelyRootCause: String?) -> String
    {
        let seatCorpus = [seat, subjectRole].joined(separator: " ").lowercased()
        let corpus = ([seat, subjectRole, diagnosisID, diagnosis, likelyRootCause ?? ""] + evidence)
            .joined(separator: " ")
            .lowercased()

        if self.containsAny(["executor", "implement", "builder", "maker"], in: seatCorpus) {
            return "executor"
        }

        if self.containsAny(["verify", "verifier", "checker", "auditor"], in: seatCorpus) {
            return "verifier"
        }

        if self.containsAny(["research", "researcher", "search"], in: seatCorpus) {
            return "researcher"
        }

        if self.containsAny(["coord", "triage", "dispatch", "manager", "router"], in: seatCorpus) {
            return "coordinator"
        }

        if self.containsAny(
            ["watchdog", "release", "ship", "review", "guard", "qa", "gate"],
            in: corpus)
        {
            return "release_guard"
        }

        if self.containsAny(
            ["control", "gateway", "heartbeat", "transport", "linking", "health", "approval", "pairing", "device"],
            in: corpus)
        {
            return "infrastructure_guard"
        }

        if self.containsAny(["research", "search", "market", "trend", "source"], in: corpus) {
            return "researcher"
        }

        if self.containsAny(["verify", "verifier", "evidence", "halluc", "citation", "proof"], in: corpus) {
            return "verifier"
        }

        if self.containsAny(["coord", "triage", "dispatch", "handoff", "manager", "router"], in: corpus) {
            return "coordinator"
        }

        return "executor"
    }

    static func parseMarkdownFields(_ content: String) -> [String: String] {
        var fields: [String: String] = [:]
        for rawLine in content.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.hasPrefix("-") else { continue }
            let body = trimmed.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines)
            guard let colonIndex = body.firstIndex(of: ":") else { continue }
            let key = body[..<colonIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let value = body[body.index(after: colonIndex)...].trimmingCharacters(in: .whitespacesAndNewlines)
            guard let key = key.nonEmpty, let value = value.nonEmpty else { continue }
            fields[key] = value
        }
        return fields
    }

    static func markdownBulletItems(in content: String, under heading: String) -> [String] {
        let target = self.normalizedHeading(heading)
        var capture = false
        var items: [String] = []

        for rawLine in content.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)

            if trimmed.hasPrefix("#") {
                capture = self.normalizedHeading(trimmed) == target
                continue
            }

            guard capture else { continue }
            if trimmed.hasPrefix("-") {
                let item = trimmed.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines)
                if let item = item.nonEmpty {
                    items.append(item)
                }
                continue
            }

            if !trimmed.isEmpty && !items.isEmpty {
                break
            }
        }

        return items
    }

    private static func contract(
        for issue: IssueContext,
        constitution: WorkspaceProfessionalConstitution?) -> ProfessionalRoleContract
    {
        let roleKey = self.inferRoleKey(
            seat: issue.seat,
            subjectRole: issue.subjectRole,
            diagnosisID: issue.diagnosisID,
            diagnosis: issue.diagnosis,
            evidence: issue.evidence,
            likelyRootCause: issue.likelyRootCause)

        let sourceLabel = constitution?.sourceLabel ?? "Heuristic role profile from seat label and diagnosis"

        switch roleKey {
        case "release_guard":
            return ProfessionalRoleContract(
                id: roleKey,
                title: "Release Guard",
                summary: "Protect ship quality by blocking unsupported claims, skipped gates, and unverified completion.",
                mission: "Turn release uncertainty into a clear go or no-go path backed by evidence.",
                behavioralConstitution: self.merged(
                    [
                        "Name the gate or quality bar before making a ship recommendation.",
                        "Prefer blocking a weak release over smoothing it over with confidence.",
                        "Treat stale state and fake completion as release risks, not style issues.",
                    ],
                    constitution?.nonNegotiables),
                evidenceObligations: self.merged(
                    [
                        "Cite the test, log, artifact, or review note that justifies the claim.",
                        "Say what is still unknown instead of implying approval.",
                        "Require a concrete checkpoint before clearing the next step.",
                    ],
                    constitution?.defaultOutputs),
                escalationRules: [
                    "Escalate signing, compliance, permission, or policy blockers early.",
                    "Hand off with owner and next checkpoint, not vague concern.",
                ],
                sourceLabel: sourceLabel)
        case "infrastructure_guard":
            return ProfessionalRoleContract(
                id: roleKey,
                title: "Infrastructure Guard",
                summary: "Protect the control path, heartbeat, and runtime prerequisites the correction loop depends on.",
                mission: constitution?.mission ?? "Restore trustworthy transport and system state before bot-level conclusions.",
                behavioralConstitution: self.merged(
                    [
                        "Repair prerequisites before trusting downstream diagnosis.",
                        "Treat partial connectivity and stale health as active risks.",
                        "Do not call the lane healthy until liveness is proven again.",
                    ],
                    constitution?.nonNegotiables),
                evidenceObligations: self.merged(
                    [
                        "Anchor claims to transport state, heartbeat freshness, and health output.",
                        "Separate confirmed recovery from hopeful reconnecting.",
                        "Keep the evidence chain explicit when the system is degraded.",
                    ],
                    constitution?.defaultOutputs),
                escalationRules: [
                    "Escalate account, certificate, pairing, or environment blockers as soon as they stop local progress.",
                    "Mark which prerequisite is still missing before reopening downstream correction.",
                ],
                sourceLabel: sourceLabel)
        case "researcher":
            return ProfessionalRoleContract(
                id: roleKey,
                title: "Researcher",
                summary: "Reduce uncertainty with sourced findings, comparisons, and clearly marked inference.",
                mission: "Find reliable evidence before the team commits to a fix, launch, or judgment call.",
                behavioralConstitution: self.merged(
                    [
                        "Search before asserting.",
                        "Keep facts, interpretations, and recommendations visibly separate.",
                        "Prefer breadth of evidence over one convenient source.",
                    ],
                    constitution?.nonNegotiables),
                evidenceObligations: [
                    "Bring back concrete sources, not vibes.",
                    "Mark what is inferred versus directly confirmed.",
                    "Capture the strongest counterexample before settling on a recommendation.",
                ],
                escalationRules: [
                    "Escalate when the evidence base is too thin to support a decision.",
                    "Invite verification when a claim would change money, policy, or launch timing.",
                ],
                sourceLabel: sourceLabel)
        case "verifier":
            return ProfessionalRoleContract(
                id: roleKey,
                title: "Verifier",
                summary: "Separate observed facts from inference and challenge unsupported claims before they spread.",
                mission: "Keep the team aligned to provenance, proof, and explicit uncertainty.",
                behavioralConstitution: self.merged(
                    [
                        "Interrogate claims that arrive without evidence.",
                        "Prefer explicit uncertainty over confident guessing.",
                        "Do not let polished language masquerade as proof.",
                    ],
                    constitution?.nonNegotiables),
                evidenceObligations: [
                    "Cite the log line, test, artifact, or source that supports the conclusion.",
                    "If proof is missing, label the claim as unverified.",
                    "Require one falsifiable checkpoint in the next reply.",
                ],
                escalationRules: [
                    "Escalate to a researcher or operator when the available evidence is incomplete.",
                    "Stop the loop from promoting a template that only sounds right.",
                ],
                sourceLabel: sourceLabel)
        case "coordinator":
            return ProfessionalRoleContract(
                id: roleKey,
                title: "Coordinator",
                summary: "Keep multi-agent correction ordered, owned, and time-bounded.",
                mission: "Turn scattered activity into explicit sequencing, ownership, and checkpoints.",
                behavioralConstitution: self.merged(
                    [
                        "Name the owner, next move, and unblock condition for every active branch.",
                        "Prefer narrow handoffs over broad motivational talk.",
                        "Do not absorb work that should remain owned by another seat.",
                    ],
                    constitution?.nonNegotiables),
                evidenceObligations: [
                    "Track which handoff is blocked and why.",
                    "Keep the next checkpoint explicit and time-bounded.",
                    "Summarize current state in a way another seat can act on immediately.",
                ],
                escalationRules: [
                    "Escalate when ownership is ambiguous or no seat can close the blocker alone.",
                    "Re-route the case instead of letting it sit in diffuse discussion.",
                ],
                sourceLabel: sourceLabel)
        default:
            return ProfessionalRoleContract(
                id: "executor",
                title: "Executor",
                summary: "Convert diagnosis into one bounded, verifiable delivery step.",
                mission: "Reduce drift by shipping the smallest useful artifact that proves progress.",
                behavioralConstitution: self.merged(
                    [
                        "Prefer scoped completion over open-ended motion.",
                        "Do the work or surface the blocker clearly; do not simulate progress.",
                        "Close the loop with the next artifact, diff, test, or handoff.",
                    ],
                    constitution?.nonNegotiables),
                evidenceObligations: self.merged(
                    [
                        "End each round with one verifiable checkpoint or artifact.",
                        "State what changed, not just what was considered.",
                        "If blocked, name the exact blocker and owner.",
                    ],
                    constitution?.defaultOutputs),
                escalationRules: [
                    "Escalate the blocker when the artifact cannot be produced this round.",
                    "Shrink scope before asking for more time.",
                ],
                sourceLabel: sourceLabel)
        }
    }

    private static func driftAssessment(
        for issue: IssueContext,
        contract: ProfessionalRoleContract) -> ProfessionalRoleDriftAssessment
    {
        let category = self.driftCategory(for: issue)
        let rootCauseLine = issue.likelyRootCause?.nonEmpty.map { "Current likely root cause: \($0)" }

        switch category {
        case .evidenceBoundary:
            return ProfessionalRoleDriftAssessment(
                title: "Evidence boundary slipped",
                detail: "This case looks like \(contract.title) drift: the next intervention should separate observed facts from inference before making a stronger claim.",
                highlights: self.merged(
                    [
                        "Separate what is observed from what is inferred in the next reply.",
                        contract.evidenceObligations.first ?? issue.prescription,
                        issue.prescription,
                        rootCauseLine,
                    ],
                    []),
                systemImage: "checklist.unchecked")
        case .executionDiscipline:
            return ProfessionalRoleDriftAssessment(
                title: "Execution discipline slipped",
                detail: "This case looks like \(contract.title) drift: time is passing without the checkpoint or artifact that role owes the team.",
                highlights: self.merged(
                    [
                        "Collapse the task to one proof-bearing checkpoint.",
                        contract.behavioralConstitution.first ?? issue.prescription,
                        issue.prescription,
                        rootCauseLine,
                    ],
                    []),
                systemImage: "shippingbox")
        case .guardrail:
            return ProfessionalRoleDriftAssessment(
                title: "Guardrail discipline slipped",
                detail: "This case looks like \(contract.title) drift: prerequisite transport or health signals are not stable enough to trust downstream conclusions.",
                highlights: self.merged(
                    [
                        "Treat transport, health, and heartbeat as prerequisites, not background noise.",
                        contract.evidenceObligations.first ?? issue.prescription,
                        issue.prescription,
                        rootCauseLine,
                    ],
                    []),
                systemImage: "shield.lefthalf.filled")
        case .escalationEtiquette:
            return ProfessionalRoleDriftAssessment(
                title: "Escalation etiquette slipped",
                detail: "This case looks like \(contract.title) drift: the blocker needs an explicit approval path, owner, or escalation instead of more idle motion.",
                highlights: self.merged(
                    [
                        "Name the blocked approval or owner instead of narrating around it.",
                        contract.escalationRules.first ?? issue.prescription,
                        issue.prescription,
                        rootCauseLine,
                    ],
                    []),
                systemImage: "arrow.up.right.circle")
        case .scopeDiscipline:
            return ProfessionalRoleDriftAssessment(
                title: "Scope discipline slipped",
                detail: "This case looks like \(contract.title) drift: the bot needs a tighter remit and a clearer next boundary before it keeps going.",
                highlights: self.merged(
                    [
                        "Re-state the job boundary before taking the next step.",
                        contract.behavioralConstitution.first ?? issue.prescription,
                        issue.prescription,
                        rootCauseLine,
                    ],
                    []),
                systemImage: "scope")
        }
    }

    private static func driftCategory(for issue: IssueContext) -> DriftCategory {
        let corpus = ([issue.title, issue.subtitle, issue.diagnosisID, issue.diagnosis, issue.likelyRootCause ?? ""] + issue.evidence)
            .joined(separator: " ")
            .lowercased()

        if self.containsAny(["stall", "timeout", "five minutes", "no output", "burning time"], in: corpus) {
            return .executionDiscipline
        }
        if self.containsAny(["halluc", "fabricat", "citation", "evidence", "proof", "artifact"], in: corpus) {
            return .evidenceBoundary
        }
        if self.containsAny(["control", "gateway", "heartbeat", "transport", "health", "reconnect", "linking"], in: corpus) {
            return .guardrail
        }
        if self.containsAny(["pairing", "approval", "access", "permission", "blocked"], in: corpus) {
            return .escalationEtiquette
        }
        if self.containsAny(["deliver", "artifact"], in: corpus) {
            return .executionDiscipline
        }
        return .scopeDiscipline
    }

    private static func candidateDocumentRoots() -> [URL] {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let cwd = URL(fileURLWithPath: FileManager().currentDirectoryPath, isDirectory: true)
        return self.uniqueURLs([
            OpenClawConfigFile.defaultWorkspaceURL(),
            repoRoot,
            cwd,
        ])
    }

    private static func document(named name: String, in root: URL) -> String? {
        let url = root.appendingPathComponent(name)
        guard FileManager().fileExists(atPath: url.path) else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    private static func normalizedHeading(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "#", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    private static func containsAny(_ terms: [String], in corpus: String) -> Bool {
        terms.contains { corpus.contains($0) }
    }

    private static func merged(_ primary: [String?], _ secondary: [String]?) -> [String] {
        var ordered: [String] = []
        var seen: Set<String> = []

        for value in primary.compactMap({ $0 }) + (secondary ?? []) {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let normalized = normalized.nonEmpty else { continue }
            let key = normalized.lowercased()
            if seen.insert(key).inserted {
                ordered.append(normalized)
            }
        }

        return ordered
    }

    private static func uniqueURLs(_ values: [URL]) -> [URL] {
        var ordered: [URL] = []
        var seen: Set<String> = []
        for value in values {
            let key = value.standardizedFileURL.path
            if seen.insert(key).inserted {
                ordered.append(value)
            }
        }
        return ordered
    }
}
