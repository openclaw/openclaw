import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingOpenClawIDRenderTests {
    @Test(.enabled(if: !OpenClawIDNodeNativeEndpoint.isPackaged &&
            ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_DIR"] != nil))
    func `unpackaged production invitation entry renders unavailable`() throws {
        let output = try OnboardingRenderTests.outputDirectory()
        for dark in [false, true] {
            let model = OnboardingOpenClawIDModel(service: OnboardingNodeInvitationService())
            #expect(model.begin(.joinNode) == nil)
            try #require(model.unavailableReason != nil)
            try #require(model.step == .nodeInvitation)
            try OnboardingRenderTests.capture(
                OnboardingOpenClawIDView(model: model),
                name: "id-node-unavailable",
                label: "Production availability gate · native transport not packaged · no enrollment",
                output: output,
                width: 574,
                dark: dark)
            model.cancel()
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_DIR"] != nil))
    func `native ID screens render with explicit fixture data`() async throws {
        let output = try OnboardingRenderTests.outputDirectory()
        let approval = URL(string: "https://fixture.example.test/access")
        let cases: [(String, OnboardingOpenClawIDStep)] = [
            ("id-node-invitation", .nodeInvitation),
            ("id-node-connecting", .nodeConnection(claw: "studio-fixture", connected: false)),
            ("id-node-connected", .nodeConnection(claw: "studio-fixture", connected: true)),
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
            "id-node-invitation": "real invitation/Discovery enrollment acceptance",
            "id-node-connecting": "real native node handshake",
            "id-node-connected": "real native node handshake and invocation",
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
            for dark in [false, true] {
                let model = OnboardingOpenClawIDModel(service: RenderService(step: step))
                await model.begin(.connect)?.value
                try #require(model.step == step)
                try OnboardingRenderTests.capture(
                    OnboardingOpenClawIDView(model: model),
                    name: name,
                    label: "Native sheet · FIXTURE data\nMissing: \(dependency)",
                    output: output,
                    width: 574,
                    dark: dark)
                model.cancel()
            }
        }
    }
}

@MainActor
private struct RenderService: OnboardingOpenClawIDService {
    let unavailableReason: String? = nil
    let step: OnboardingOpenClawIDStep

    func start(_: OnboardingOpenClawIDIntent) async throws -> OnboardingOpenClawIDStep {
        self.step
    }

    func perform(_: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep {
        self.step
    }

    func cancel() {}
}
