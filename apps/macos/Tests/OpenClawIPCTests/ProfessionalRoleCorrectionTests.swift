import Foundation
import Testing
@testable import OpenClaw

struct ProfessionalRoleCorrectionTests {
    @Test
    func loadsWorkspaceConstitutionFromMarkdownFiles() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-role-constitution-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)

        try """
        # IDENTITY.md - Max | Engineering

        - Name: Max
        - Seat: Seat 03
        - Department: Engineering
        - Role: Head of Engineering
        - Mission: Repair systems until the company can move again.

        ## Default outputs

        - code change
        - verification note
        """.write(
            to: root.appendingPathComponent("IDENTITY.md"),
            atomically: true,
            encoding: .utf8)

        try """
        # SOUL.md - Max | Engineering

        ## Your non-negotiables

        - No repro, no confident diagnosis.
        - No verification, no closure.
        """.write(
            to: root.appendingPathComponent("SOUL.md"),
            atomically: true,
            encoding: .utf8)

        let constitution = try #require(ProfessionalRoleCorrection.workspaceConstitution(documentRoot: root))
        #expect(constitution.name == "Max")
        #expect(constitution.role == "Head of Engineering")
        #expect(constitution.mission == "Repair systems until the company can move again.")
        #expect(constitution.nonNegotiables == [
            "No repro, no confident diagnosis.",
            "No verification, no closure.",
        ])
        #expect(constitution.defaultOutputs == [
            "code change",
            "verification note",
        ])
    }

    @Test
    func infersReleaseGuardForWatchdogStyleSeat() {
        let role = ProfessionalRoleCorrection.inferRoleKey(
            seat: "Bot: Watchdog",
            subjectRole: "bot",
            diagnosisID: "release_gate_unverified",
            diagnosis: "Release readiness is being claimed without proof.",
            evidence: ["No artifact or signed build is attached."],
            likelyRootCause: "The bot is smoothing over release risk.")

        #expect(role == "release_guard")
    }

    @Test
    func buildsExecutionDriftAssistForStalledExecutorCase() {
        let assessment = ProfessionalRoleCorrection.assessment(
            seat: "Bot: Executor",
            subjectRole: "bot",
            title: "Executor has been correcting for more than five minutes",
            subtitle: "Build and verify the next step",
            diagnosisID: "correction_stall_over_5m",
            diagnosis: "The lane is spending time without producing a fresh verified intervention result.",
            prescription: "Shrink scope, ship one verified output, then reassess whether deeper correction is still needed.",
            evidence: [
                "Current activity: build release notes",
                "No fresh artifact has appeared yet.",
            ],
            likelyRootCause: "The lane is burning time without producing a fresh verified artifact.")

        #expect(assessment.contract.title == "Executor")
        #expect(assessment.drift.title == "Execution discipline slipped")
        #expect(assessment.drift.highlights.contains(
            "Shrink scope, ship one verified output, then reassess whether deeper correction is still needed."))
    }
}
