import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingOpenClawIDRenderTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_DIR"] != nil))
    func `native ID screens render with explicit fixture data`() throws {
        let output = try OnboardingRenderTests.outputDirectory()
        let approval = URL(string: "https://fixture.example.test/access")
        let cases: [(String, OnboardingOpenClawIDStep)] = [
            ("id-sign-in", .signIn),
            ("id-claws", .claws(account: "owner@example.test", claws: [
                .init(id: "studio", name: "studio-fixture", relationship: "Owner", online: true),
                .init(id: "team", name: "team-fixture", relationship: "Operator", online: true),
                .init(id: "laptop", name: "laptop-fixture", relationship: "Owner", online: false),
            ])),
            ("id-recovery-kit", .recoveryKit(hostname: "studio-fixture", saved: false)),
            (
                "id-add-mac",
                .addMac(
                    claw: "studio-fixture",
                    device: "Example Mac",
                    capabilities: """
                    Run commands, share the screen, use the camera and show notifications, \
                    subject to your permissions.
                    """)),
            ("id-compare-code", .compareCode(
                claw: "studio-fixture", device: "Example Mac", code: "482 913", approvalURL: approval)),
            ("id-chat-approval", .chatAccess(claw: "studio-fixture", approvalURL: approval)),
            ("id-connected", .connected(claw: "studio-fixture")),
            ("id-reachable", .reachable(hostname: "studio-fixture")),
        ]
        let dependencies = [
            "id-sign-in": "native account callback",
            "id-claws": "native account callback and authenticated claw-list wiring",
            "id-recovery-kit": "owner signer/kit custody",
            "id-add-mac": "#194201/#196445 enrollment wiring",
            "id-compare-code": "#194201/#196445 enrollment wiring",
            "id-chat-approval": "member/operator enrollment",
            "id-connected": "#194201/#196445 enrollment wiring and member/operator enrollment",
            "id-reachable": "owner signer/kit custody and native account callback",
        ]
        for (name, step) in cases {
            let dependency = try #require(dependencies[name])
            try OnboardingRenderTests.capture(
                OnboardingOpenClawIDContent(step: step, unavailableReason: nil, action: { _ in }),
                name: name,
                label: "Native SwiftUI · FIXTURE data\nMissing: \(dependency)",
                output: output)
        }
    }
}
