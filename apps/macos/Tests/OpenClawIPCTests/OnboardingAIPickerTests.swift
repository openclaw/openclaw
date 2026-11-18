import Foundation
import Testing
@testable import OpenClaw

/// Option ids and kinds mirror what `openclaw.setup.detect` derives from the bundled
/// openai, anthropic, and google manifests (main at 7ff0d902b94).
struct OnboardingAIPickerTests {
    private typealias Model = OnboardingAISetupModel

    private static let authOptions = """
    [
      {"id":"openai-device-code","brandId":"openai","label":"Codex login (device code)","kind":"device-code","featured":true},
      {"id":"anthropic-cli","brandId":"anthropic","label":"Anthropic Claude CLI","kind":"install","featured":true},
      {"id":"openai","brandId":"openai","label":"Codex login (browser)","kind":"oauth","featured":false},
      {"id":"openai-token-sharing","brandId":"openai","label":"Sign in with ChatGPT","kind":"oauth","featured":false},
      {"id":"xai-device-code","brandId":"xai","label":"xAI device code","kind":"device-code","featured":false}
    ]
    """

    private static let manualProviders = """
    [
      {"id":"openai-api-key","brandId":"openai","label":"OpenAI API Key"},
      {"id":"gemini-api-key","brandId":"google","label":"Google AI Studio API key"}
    ]
    """

    private static func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func `found logins are tagged and only tested when picked`() throws {
        let candidates: [Model.Candidate] = try Self.decode("""
        [
          {"kind":"claude-cli","label":"Claude Code","detail":"installed","modelRef":"claude-cli/claude-sonnet"},
          {"kind":"ollama-auto","brandId":"ollama","label":"Ollama","detail":"available locally","modelRef":"ollama/llama3.2"},
          {"kind":"saved:openrouter","brandId":"openrouter","label":"Saved OpenRouter sign-in","detail":"saved","modelRef":"openrouter/auto"}
        ]
        """)
        let picker = try OnboardingAIPicker(
            candidates: candidates,
            authOptions: Self.decode(Self.authOptions),
            manualProviders: Self.decode(Self.manualProviders),
            prepareOptions: [])

        #expect(picker.rows.map(\.id) == [.found("saved:openrouter"), .chatGPT, .claude, .gemini, .apiKey, .localModel])
        let rows = Dictionary(uniqueKeysWithValues: picker.rows.map { ($0.id, $0) })
        // A browser sign-in beats the featured device code on this Mac.
        guard case let .signIn(chatGPT) = rows[.chatGPT]?.action else {
            Issue.record("ChatGPT row has no sign-in")
            return
        }
        #expect(chatGPT.id == "openai")
        #expect(rows[.chatGPT]?.onThisMac == false)
        #expect(rows[.claude]?.action == .candidate("claude-cli"))
        #expect(rows[.claude]?.onThisMac == true)
        // No Google sign-in exists for setup, so Gemini opens its key.
        #expect(rows[.gemini]?.action == .apiKey("gemini-api-key"))
        #expect(rows[.localModel]?.onThisMac == true)
        #expect(picker.localCandidates.map(\.kind) == ["ollama-auto"])
        // Options no row uses stay reachable behind More providers.
        #expect(picker.moreAuthOptions.map(\.id) == [
            "openai-device-code",
            "anthropic-cli",
            "openai-token-sharing",
            "xai-device-code",
        ])
    }
}
