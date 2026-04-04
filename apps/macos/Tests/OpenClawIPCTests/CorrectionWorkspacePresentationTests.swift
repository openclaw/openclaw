import Testing
@testable import OpenClaw

struct CorrectionWorkspacePresentationTests {
    @Test
    func closureSnapshotMarksVerificationAsActiveBeforeFreshProofArrives() {
        let issue = CorrectionWorkspaceIssue(
            id: "issue-1",
            seat: "Bot: Release Guard",
            title: "Release claim has no proof",
            subtitle: "Needs evidence-backed follow-up",
            diagnosis: "The lane is claiming readiness without fresh runtime evidence.",
            prescription: "Open the case, request fresh proof, and hold the ship gate until it arrives.",
            evidence: ["No fresh signed artifact is attached."],
            history: [],
            severity: .warning,
            casebookGuidance: CorrectionWorkspaceStatusSnapshot(
                title: "Tracking precedent",
                detail: "This round is already linked to the casebook.",
                systemImage: "books.vertical"),
            interventionProgress: CorrectionWorkspaceProgressSnapshot(
                title: "Awaiting fresh runtime proof",
                detail: "No post-treatment artifact has arrived yet.",
                highlights: [],
                systemImage: "hourglass"),
            primaryAction: .openChat,
            secondaryAction: nil)

        let closure = issue.closureSnapshot
        #expect(closure.headline == "Loop is waiting on fresh post-treatment proof")
        #expect(closure.stages.first(where: { $0.title == "Verify" })?.state == .active)
        #expect(closure.stages.first(where: { $0.title == "Casebook" })?.state == .active)
    }

    @Test
    func closureSnapshotMarksVerificationAndCasebookAsCompleteAfterFreshProof() {
        let issue = CorrectionWorkspaceIssue(
            id: "issue-2",
            seat: "Bot: Executor",
            title: "Fresh output landed",
            subtitle: "Verification can close the round",
            diagnosis: "The lane produced a new artifact after treatment.",
            prescription: "Review the artifact, confirm it resolves the diagnosis, and record the outcome.",
            evidence: ["A fresh assistant-visible artifact is attached."],
            history: ["Yesterday: the same remedy resolved cleanly."],
            severity: .watch,
            casebookGuidance: CorrectionWorkspaceStatusSnapshot(
                title: "Clean precedent exists",
                detail: "The casebook already has a strong prior resolution for this diagnosis.",
                systemImage: "checkmark.seal"),
            interventionProgress: CorrectionWorkspaceProgressSnapshot(
                title: "Fresh artifact observed",
                detail: "A new artifact landed after treatment began.",
                highlights: [],
                systemImage: "checklist"),
            primaryAction: .openChat,
            secondaryAction: nil)

        let closure = issue.closureSnapshot
        #expect(closure.stages.first(where: { $0.title == "Verify" })?.state == .complete)
        #expect(closure.stages.first(where: { $0.title == "Casebook" })?.state == .complete)
    }

    @Test
    func casebookIssuesUseSimplePrimaryActionCopy() {
        let issue = CorrectionWorkspaceIssue(
            id: "issue-3",
            seat: "Bot: Research Guard",
            title: "Evidence trail drifted",
            subtitle: "Needs an evidence-backed correction",
            diagnosis: "The seat started summarizing without grounding itself in observed proof.",
            prescription: "Send a correction that names the evidence gap and requests a verifiable checkpoint.",
            evidence: ["The latest answer claims completion without an attached artifact."],
            history: [],
            severity: .warning,
            primaryAction: .openChat,
            secondaryAction: nil)

        #expect(issue.primaryActionDisplayTitle == "Send fix")
        #expect(issue.primaryActionDisplaySystemImage == "paperplane.fill")
        #expect(issue.primaryActionGuidance == "Open the live lane and send an evidence-backed correction for this seat.")
    }

    @Test
    func nonCasebookSeatsKeepManualChatLanguage() {
        let issue = CorrectionWorkspaceIssue(
            id: "issue-4",
            seat: "Bot: Runtime Monitor",
            title: "Manual follow-up needed",
            subtitle: "The user still needs to inspect the seat directly.",
            diagnosis: "This seat does not dispatch through the casebook flow.",
            prescription: "Open chat and inspect the live context before taking action.",
            evidence: ["No automated casebook round is attached to this seat."],
            history: [],
            severity: .watch,
            tracksCasebook: false,
            primaryAction: .openChat,
            secondaryAction: nil)

        #expect(issue.primaryActionDisplayTitle == "Open chat")
        #expect(issue.primaryActionDisplaySystemImage == "bubble.left.and.bubble.right")
        #expect(issue.primaryActionGuidance == "Jump into the live lane so you can steer this seat directly.")
    }
}
