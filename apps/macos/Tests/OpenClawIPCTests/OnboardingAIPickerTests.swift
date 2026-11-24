import Foundation
import Testing
@testable import OpenClaw

/// Option ids and kinds mirror what `openclaw.setup.detect` derives from the bundled
/// openai, anthropic, and google manifests (main at 7ff0d902b94).
struct OnboardingAIPickerTests {
    private typealias Model = OnboardingAISetupModel

    private static let authOptions = """
    [
      {"id":"openai-device-code","brandId":"openai","label":"Codex login (device code)",
       "kind":"device-code","featured":true},
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
          {"kind":"ollama-auto","brandId":"ollama","label":"Ollama",
           "detail":"available locally","modelRef":"ollama/llama3.2"},
          {"kind":"saved:openrouter","brandId":"openrouter","label":"Saved OpenRouter sign-in",
           "detail":"saved","modelRef":"openrouter/auto"}
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
        #expect(rows[.chatGPT]?.detected == false)
        #expect(rows[.claude]?.action == .candidate("claude-cli"))
        #expect(rows[.claude]?.detected == true)
        // No Google sign-in exists for setup, so Gemini opens its key.
        #expect(rows[.gemini]?.action == .apiKey("gemini-api-key"))
        #expect(rows[.localModel]?.detected == true)
        #expect(picker.localCandidates.map(\.kind) == ["ollama-auto"])
        // Options no row uses stay reachable behind More providers.
        #expect(picker.moreAuthOptions.map(\.id) == [
            "openai-device-code",
            "anthropic-cli",
            "openai-token-sharing",
            "xai-device-code",
        ])
    }

    @Test func `local downloads sit on the local model card until the app has a model`() throws {
        let installs: [Model.RecommendedInstall] = try Self.decode("""
        [
          {"id":"ollama","brandId":"ollama","label":"Ollama","hint":"Run open models locally","website":"https://ollama.com/download","icon":"https://cdn.simpleicons.org/ollama"},
          {"id":"lmstudio","label":"LM Studio","hint":"Local model desktop app","website":"https://lmstudio.ai/download","icon":"https://cdn.simpleicons.org/lmstudio"},
          {"id":"claude-code","brandId":"claude","label":"Claude Code","hint":"Anthropic's coding agent CLI",
           "website":"https://code.claude.com/docs/en/quickstart","icon":"https://cdn.simpleicons.org/claudecode"}
        ]
        """)
        let fresh = OnboardingAIPicker(
            candidates: [],
            authOptions: [],
            manualProviders: [],
            prepareOptions: [],
            recommendedInstalls: installs)
        #expect(fresh.rows.map(\.id) == [.localModel])
        #expect(fresh.localInstalls.map(\.id) == ["ollama", "lmstudio"])
        #expect(fresh.otherInstalls.map(\.id) == ["claude-code"])

        let ollamaModel: [Model.Candidate] = try Self.decode("""
        [{"kind":"ollama-auto","label":"Ollama","detail":"available locally","modelRef":"ollama/llama3.2"}]
        """)
        let found = OnboardingAIPicker(
            candidates: ollamaModel,
            authOptions: [],
            manualProviders: [],
            prepareOptions: [],
            recommendedInstalls: installs)
        #expect(found.localInstalls.map(\.id) == ["lmstudio"])
    }

    @Test func `a running app without a model keeps its download link`() throws {
        let prepareOptions: [Model.PrepareOption] = try Self.decode("""
        [{"id":"ollama","brandId":"ollama","label":"Ollama","website":"https://ollama.com/download"}]
        """)
        let picker = OnboardingAIPicker(
            candidates: [],
            authOptions: [],
            manualProviders: [],
            prepareOptions: prepareOptions,
            recommendedInstalls: [])

        #expect(picker.localInstalls.map(\.website) == ["https://ollama.com/download"])
    }

    @Test func `late discovery keeps the selected Gemini key form available`() throws {
        let providers: [Model.ManualProvider] = try Self.decode(Self.manualProviders)
        let early = OnboardingAIPicker(candidates: [], authOptions: [], manualProviders: providers, prepareOptions: [])
        let selection = try #require(early.rows.first { $0.id == .gemini })
        let candidates: [Model.Candidate] = try Self.decode("""
        [{"kind":"gemini-cli","label":"Gemini CLI","detail":"installed","modelRef":"gemini-cli/gemini-3-pro"}]
        """)
        let settled = OnboardingAIPicker(
            candidates: candidates, authOptions: [], manualProviders: providers, prepareOptions: [])

        #expect(settled.row(for: selection, manualProviders: providers)?.action == .apiKey("gemini-api-key"))
        #expect(settled.row(for: selection, manualProviders: [])?.action == .candidate("gemini-cli"))
    }
}
