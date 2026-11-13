import AppKit
import Foundation
import SwiftUI
import Testing
@testable import OpenClaw

/// Renders of the sign-in-first OpenClaw ID screens with fixture data (opt-in render sandbox).
@MainActor
struct OpenClawIDSignInRenderTests {
    private static let label = "Sign-in-first OpenClaw ID · real view · FIXTURE data · not live"
    private static let mac = "Josh’s Mac Studio"

    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_DIR"] != nil))
    func `onboarding pages offer OpenClaw ID sign in`() throws {
        let output = try OnboardingRenderTests.outputDirectory()
        let state = AppState(preview: true)
        state.connectionMode = .unconfigured
        state.isPaused = true
        let view = OnboardingView(state: state, gatewaySelectionPersister: { true }, dashboardHandoffOpener: { _ in })
        let height = OnboardingView.contentHeight(for: OnboardingView.windowHeight)
        try OnboardingRenderTests.capturePage(
            view.pageView(for: 1, contentHeight: height), name: "mac-a02-where", label: Self.label, output: output)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_DIR"] != nil))
    func `sign in first sheet steps render`() async throws {
        let output = try OnboardingRenderTests.outputDirectory()
        let claw = "studio-k7x2q.crabd.me"
        let cases: [(String, OnboardingOpenClawIDStep)] = [
            ("mac-a03-sign-in", .signIn),
            ("mac-a04-signing-in", .signingIn),
            ("mac-a05-claw-picker", .claws(account: "owner@example.test", claws: [
                .init(id: "studio", name: claw, relationship: "Owner", online: true),
                .init(id: "team", name: "team-k7x2q.crabd.me", relationship: "Operator", online: true),
                .init(id: "lab", name: "lab-k7x2q.crabd.me", relationship: "Owner", online: false),
            ])),
            ("mac-a06-choose-approval", .chooseApproval(claw: claw, device: Self.mac)),
            ("mac-a07-compare-code", .ownerCompareCode(
                claw: claw, device: Self.mac, code: "482 913", approvalURL: URL(string: "https://\(claw)/"),
                confirmed: false)),
            ("mac-a08-compare-code-confirmed", .ownerCompareCode(
                claw: claw, device: Self.mac, code: "482 913", approvalURL: URL(string: "https://\(claw)/"),
                confirmed: true)),
            ("mac-a09-owner-connected", .ownerConnected(
                claw: claw, device: Self.mac, approvedWith: "Approved from your other device")),
            ("mac-b02-kit-connected", .ownerConnected(
                claw: claw, device: Self.mac, approvedWith: "Approved with your recovery kit")),
            ("mac-f01-claw-offline", .problem(.clawOffline(claw: "lab-k7x2q.crabd.me"))),
            ("mac-f02-denied", .problem(.denied(claw: claw))),
            ("mac-f03-expired", .problem(.expired(claw: claw))),
            ("mac-f04-kit-invalid", .problem(.kitInvalid(claw: claw))),
            ("mac-f05-no-claws", .problem(.notInvited(account: "sam@example.test"))),
            ("mac-f06-member-needs-invite", .problem(.memberNeedsInvite(claw: "team-k7x2q.crabd.me"))),
            ("mac-f07-sign-in-failed", .problem(.signInFailed)),
        ]
        // The recovery-kit entry step is not rendered here: NSSecureTextField layout blocks on the
        // window server lookup this sandbox denies.
        for (name, step) in cases {
            let model = OnboardingOpenClawIDModel(service: RenderService(step: step), onJoined: { _ in })
            await model.begin(.connect)?.value
            try #require(model.step == step)
            try OnboardingRenderTests.capture(
                OnboardingOpenClawIDView(model: model), name: name, label: Self.label, output: output,
                width: 574, dark: false)
            model.cancel()
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_DIR"] != nil))
    func `failed primary migration offers retry`() async throws {
        let output = try OnboardingRenderTests.outputDirectory()
        let step = OnboardingOpenClawIDStep.ownerConnected(
            claw: "studio.example.test", device: "Fixture Mac", approvedWith: "Approved with your recovery kit")
        let model = OnboardingOpenClawIDModel(service: RenderService(step: step), onJoined: { _ in
            throw PrimaryGatewayControlError.persistenceFailed
        })
        await model.begin(.connect)?.value
        try #require(model.error != nil)
        try OnboardingRenderTests.capture(
            OnboardingOpenClawIDView(model: model), name: "migration-save-failure", label: Self.label,
            output: output, width: 574, dark: false)
        model.cancel()
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_DIR"] != nil))
    func `settings section and confirmations render`() throws {
        let output = try OnboardingRenderTests.outputDirectory()
        let claw = "studio-k7x2q.crabd.me"
        let model = OpenClawIDSettingsModel(store: MacOpenClawIDDeviceStore(
            defaults: UserDefaults(suiteName: "ocid-render-\(UUID().uuidString)") ?? .standard,
            databaseURL: FileManager.default.temporaryDirectory.appendingPathComponent("unused.sqlite")))
        for (name, presentation) in [
            ("mac-d01-settings-migrate", OpenClawIDSettingsPresentation.migrate(
                claw: "studio.tail0000.ts.net", route: "Tailscale", address: "studio.tail0000.ts.net")),
            ("mac-e01-settings-owner", .owner(
                claw: claw, device: Self.mac, runsTools: true, approvedWith: "Approved from your other device",
                needsSignIn: false)),
            ("mac-e04-settings-owner-tools-off", .owner(
                claw: claw, device: Self.mac, runsTools: false, approvedWith: "Approved with your recovery kit",
                needsSignIn: true)),
        ] {
            try OnboardingRenderTests.capture(
                Form { OpenClawIDSettingsSection(presentation: presentation, model: model) }.formStyle(.grouped),
                name: name, label: Self.label, output: output, width: 640, dark: false)
        }
        for (name, kind) in [
            ("mac-d02-migrate-confirm", OpenClawIDSettingsModel.Confirmation.migrate(
                claw: "studio.tail0000.ts.net", route: "Tailscale", address: "studio.tail0000.ts.net")),
            ("mac-e02-stop-tools-confirm", .stopTools(claw: claw, device: Self.mac)),
            ("mac-e05-start-tools-confirm", .startTools(claw: claw, device: Self.mac)),
            ("mac-e03-remove-mac-confirm", .remove(claw: claw, device: Self.mac)),
        ] {
            try OnboardingRenderTests.capture(
                OpenClawIDConfirmationSheet(kind: kind, confirm: {}), name: name, label: Self.label,
                output: output, width: 480, dark: false)
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

    func perform(_ action: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep {
        // The approval wait stays pending until the render cancels it.
        if case .checkApproval = action { try await Task.sleep(for: .seconds(3600)) }
        return self.step
    }

    func cancel() {}
}
