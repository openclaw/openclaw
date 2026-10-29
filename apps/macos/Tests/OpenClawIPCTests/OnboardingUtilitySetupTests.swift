import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingUtilitySetupTests {
    @Test(arguments: [false, true], ["existing-model", "provider-auto:apple-fm"])
    func `activation and verification retain the setup assistant destination`(utility: Bool, kind: String) throws {
        var payload: [String: Any] = ["ok": true, "modelRef": "apple-fm/on-device"]
        if utility { payload["modelTarget"] = "utility" }
        let direct = try JSONDecoder().decode(
            OnboardingAISetupModel.ActivateResult.self,
            from: JSONSerialization.data(withJSONObject: payload))
        let wizard = try OnboardingAISetupModel.activationWizardResult(
            done: true,
            status: "done",
            error: nil,
            preparedModelRef: nil,
            modelActivation: payload.mapValues { AnyCodable($0) },
            activationRejection: nil).get()
        let expected: OnboardingDashboardHandoff = utility || kind != "existing-model"
            ? .custodianOnboarding : .dashboard

        #expect(direct.modelTarget == (utility ? .utility : nil))
        #expect(direct.handoff(for: kind) == expected)
        #expect(wizard.handoff(for: kind) == expected)
        #expect(direct.verifies(modelRef: "apple-fm/on-device", modelTarget: utility ? .utility : nil))
        #expect(!direct.verifies(modelRef: "fixture/other-model", modelTarget: utility ? .utility : nil))
        #expect(!direct.verifies(modelRef: "apple-fm/on-device", modelTarget: utility ? nil : .utility))
        let activation = OnboardingAISetupModel.ActivationRequest.candidate(
            kind: kind,
            modelRef: "apple-fm/on-device",
            label: "Apple",
            modelTarget: utility ? .utility : nil)
        #expect(activation.params(supportsExactModel: true)["modelTarget"]?.value as? String ==
            (utility ? "utility" : nil))
    }

    @Test func `unknown activation target never becomes a primary connection`() {
        let result = OnboardingAISetupModel.activationWizardResult(
            done: true,
            status: "done",
            error: nil,
            preparedModelRef: nil,
            modelActivation: [
                "modelRef": AnyCodable("fixture/model"),
                "modelTarget": AnyCodable("unknown-target"),
            ],
            activationRejection: nil)

        #expect(throws: OnboardingAISetupError.self) { try result.get() }
    }

    @Test(arguments: [false, true])
    func `manual provider acknowledgement preserves its target before the model is known`(utility: Bool) throws {
        var payload: [String: Any] = ["id": "fixture-api-key", "label": "Fixture provider"]
        if utility { payload["modelTarget"] = "utility" }
        let provider = try JSONDecoder().decode(
            OnboardingAISetupModel.ManualProvider.self,
            from: JSONSerialization.data(withJSONObject: payload))
        let request = OnboardingAISetupModel.ActivationRequest.manual(key: "synthetic-manual-key", provider: provider)
        let params = request.params(supportsExactModel: true)

        #expect(request.modelRef == nil)
        #expect(request.modelTarget == (utility ? .utility : nil))
        #expect(params["modelTarget"]?.value as? String == (utility ? "utility" : nil))
        #expect(params["authChoice"]?.value as? String == "fixture-api-key")
        #expect(params["apiKey"]?.value as? String == "synthetic-manual-key")
        #expect(params["modelRef"] == nil)
    }

    @Test func `utility detection preserves recovery evidence without completing primary setup`() throws {
        let detection = try JSONDecoder().decode(
            OnboardingAISetupModel.DetectResult.self,
            from: Data(#"""
            {"candidates":[{"kind":"provider-auto:apple-fm","label":"Apple","detail":"On-device",
              "modelRef":"apple-fm/on-device","credentials":true,"modelTarget":"utility"}],
              "configuredModel":null,"setupModel":"apple-fm/on-device","setupComplete":false}
            """#.utf8))

        #expect(detection.candidates.first?.modelTarget == .utility)
        #expect(detection.configuredModel == nil)
        #expect(detection.setupComplete == false)
        #expect(detection.persistedActivationState?.utilityModel == "apple-fm/on-device")
        let acceptsWithoutPendingFlow: Bool = OnboardingAISetupModel.canAcceptProviderAuthReconciliation(
            pending: nil,
            state: detection.persistedActivationState)
        let acceptsPendingUtility: Bool = OnboardingAISetupModel.canAcceptProviderAuthReconciliation(
            pending: .init(modelTarget: .utility),
            state: detection.persistedActivationState)
        let acceptsPendingPrimary: Bool = OnboardingAISetupModel.canAcceptProviderAuthReconciliation(
            pending: .init(modelTarget: nil),
            state: detection.persistedActivationState)
        #expect(!acceptsWithoutPendingFlow)
        #expect(acceptsPendingUtility)
        #expect(!acceptsPendingPrimary)

        let withPrimary = try JSONDecoder().decode(
            OnboardingAISetupModel.DetectResult.self,
            from: Data(#"""
            {"candidates":[],"configuredModel":"fixture/primary","utilityModel":"apple-fm/on-device",
              "setupComplete":true}
            """#.utf8))
        #expect(withPrimary.setupModel == nil)
        #expect(withPrimary.persistedActivationState?.configuredModel == "fixture/primary")
        #expect(withPrimary.persistedActivationState?.utilityModel == "apple-fm/on-device")
    }

    @Test(arguments: [false, true])
    func `restart recovery proves a fresh transition in the selected model target`(utility: Bool) {
        typealias State = OnboardingAISetupModel.PersistedActivationState
        let model = "fixture/model"
        let before = State(setupComplete: false, configuredModel: nil, utilityModel: nil)
        let primary = State(setupComplete: true, configuredModel: model, utilityModel: nil)
        let setupOnly = State(setupComplete: false, configuredModel: nil, utilityModel: model)
        let expected = utility ? setupOnly : primary
        let otherTarget = utility ? primary : setupOnly
        let target: OnboardingAISetupModel.ModelTarget? = utility ? .utility : nil

        #expect(OnboardingAISetupModel.activationTransitionWasPersisted(
            expectedModel: model, modelTarget: target, before: before, after: expected))
        #expect(!OnboardingAISetupModel.activationTransitionWasPersisted(
            expectedModel: model, modelTarget: target, before: before, after: otherTarget))
        #expect(!OnboardingAISetupModel.activationTransitionWasPersisted(
            expectedModel: model, modelTarget: target, before: expected, after: expected))
        #expect(!OnboardingAISetupModel.activationTransitionWasPersisted(
            expectedModel: "fixture/replacement", modelTarget: target, before: before, after: expected))
        #expect(!OnboardingAISetupModel.activationTransitionWasPersisted(
            expectedModel: model, modelTarget: target, before: nil, after: expected))
    }
}
