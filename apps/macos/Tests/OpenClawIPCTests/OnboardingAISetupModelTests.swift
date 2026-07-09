import Foundation
import Testing
@testable import OpenClaw

@MainActor
private final class SetupDetectionGate {
    private var continuation: CheckedContinuation<Data, any Error>?

    func request() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func waitUntilStarted() async {
        while self.continuation == nil {
            await Task.yield()
        }
    }

    func resume(returning data: Data) {
        self.continuation?.resume(returning: data)
        self.continuation = nil
    }
}

@Suite(.serialized)
@MainActor
struct OnboardingAISetupModelTests {
    private func detectionData(setupComplete: Bool, configuredModel: String?) throws -> Data {
        let payload: [String: Any] = [
            "candidates": configuredModel.map { model in
                [[
                    "kind": "existing-model",
                    "label": "Current model",
                    "detail": "already configured",
                    "modelRef": model,
                    "recommended": true,
                    "credentials": true,
                ]]
            } ?? [],
            "manualProviders": [],
            "workspace": "/tmp/work",
            "configuredModel": configuredModel.map { $0 as Any } ?? NSNull(),
            "setupComplete": setupComplete,
        ]
        return try JSONSerialization.data(withJSONObject: payload)
    }

    @Test func `configured gateway preflight finishes exactly once`() async throws {
        let data = try detectionData(
            setupComplete: true,
            configuredModel: "openai/gpt-5.5")
        var requestCount = 0
        var completionCount = 0
        let model = OnboardingAISetupModel(requestSetupDetection: {
            requestCount += 1
            return data
        })
        model.onExistingSetup = { completionCount += 1 }

        let firstReuse = await model.reuseExistingSetupIfAvailable()
        #expect(firstReuse)
        #expect(model.connected)
        #expect(model.connectedModelRef == "openai/gpt-5.5")
        #expect(!model.needsAISetupPage)
        #expect(requestCount == 1)
        #expect(completionCount == 1)

        let secondReuse = await model.reuseExistingSetupIfAvailable()
        #expect(secondReuse)
        #expect(requestCount == 1)
        #expect(completionCount == 1)
    }

    @Test func `incomplete gateway unlocks the AI setup page`() async throws {
        let data = try detectionData(setupComplete: false, configuredModel: nil)
        let model = OnboardingAISetupModel(requestSetupDetection: { data })

        #expect(!model.needsAISetupPage)
        let reusedExistingSetup = await model.reuseExistingSetupIfAvailable()
        #expect(!reusedExistingSetup)
        #expect(model.needsAISetupPage)
        #expect(model.existingSetupPreflightComplete)
        #expect(!model.connected)
    }

    @Test func `gateway change invalidates a stale configured response`() async throws {
        let gate = SetupDetectionGate()
        let data = try detectionData(
            setupComplete: true,
            configuredModel: "openai/gpt-5.5")
        var completionCount = 0
        let model = OnboardingAISetupModel(requestSetupDetection: {
            try await gate.request()
        })
        model.onExistingSetup = { completionCount += 1 }

        let pending = Task { @MainActor in
            await model.reuseExistingSetupIfAvailable()
        }
        await gate.waitUntilStarted()
        model.resetForGatewayChange()
        gate.resume(returning: data)

        let reusedStaleSetup = await pending.value
        #expect(!reusedStaleSetup)
        #expect(model.existingSetupPreflight == .idle)
        #expect(!model.connected)
        #expect(completionCount == 0)
    }

    @Test func `detection error stays on the connection page`() async {
        struct DetectionFailure: LocalizedError {
            var errorDescription: String? {
                "Gateway connection dropped"
            }
        }
        let model = OnboardingAISetupModel(requestSetupDetection: {
            throw DetectionFailure()
        })

        let reusedExistingSetup = await model.reuseExistingSetupIfAvailable()

        #expect(!reusedExistingSetup)
        #expect(!model.needsAISetupPage)
        #expect(!model.existingSetupPreflightComplete)
        #expect(model.existingSetupPreflightError == "Gateway connection dropped")
    }

    @Test func `changed gateway identity rejects a delayed configured response`() async throws {
        let gate = SetupDetectionGate()
        let data = try detectionData(
            setupComplete: true,
            configuredModel: "openai/gpt-5.5")
        var identity = "gateway-a"
        var completionCount = 0
        let model = OnboardingAISetupModel(requestSetupDetection: {
            try await gate.request()
        })
        model.onExistingSetup = { completionCount += 1 }

        let pending = Task { @MainActor in
            await model.reuseExistingSetupIfAvailable(isCurrent: { identity == "gateway-a" })
        }
        await gate.waitUntilStarted()
        identity = "gateway-b"
        gate.resume(returning: data)

        let reusedStaleSetup = await pending.value
        #expect(!reusedStaleSetup)
        #expect(model.existingSetupPreflight == .idle)
        #expect(!model.connected)
        #expect(completionCount == 0)
    }
}
