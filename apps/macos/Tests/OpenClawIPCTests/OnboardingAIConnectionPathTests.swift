import Testing
@testable import OpenClaw

struct OnboardingAIConnectionPathTests {
    @Test(arguments: ["ollama/qwen3:8b", "lmstudio/my-model", "llama-cpp/model"])
    func `model services have their own setup path`(modelRef: String) {
        #expect(OnboardingAIConnectionPath.isModelService(modelRef))
    }

    @Test(arguments: ["openai/model", "anthropic/model", "ollama-cloud/model", "llmman/model", "custom/model", ""])
    func `account and unknown routes remain reachable without claiming locality`(modelRef: String) {
        #expect(!OnboardingAIConnectionPath.isModelService(modelRef))
    }
}
