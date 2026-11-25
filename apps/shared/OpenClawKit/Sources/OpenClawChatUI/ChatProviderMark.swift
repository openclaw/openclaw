#if os(iOS)
import SwiftUI
import UIKit

/// A provider's brand mark from the app's `ProviderIcon-*` assets, tinted like the Control UI picker. A
/// provider without a shipped mark gets a neutral glyph, never a made-up logo.
struct ChatProviderMark: View {
    let providerID: String
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 20

    var body: some View {
        Group {
            if let asset = ChatProviderMarks.assetName(for: self.providerID) {
                Image(asset)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(ChatProviderMarks.tint(for: self.providerID) ?? Color.primary)
            } else {
                Image(systemName: "cube")
                    .resizable()
                    .scaledToFit()
                    .fontWeight(.medium)
                    .foregroundStyle(OpenClawChatTheme.muted)
                    .padding(1)
            }
        }
        .frame(width: self.size, height: self.size)
        .accessibilityHidden(true)
    }
}

/// Provider id to mark, from the Control UI's table (ui/src/components/provider-icon-data.ts). The app
/// ships the same SVGs as `ProviderIcon-<name>` template images.
enum ChatProviderMarks {
    private static let names: Set<String> = [
        "abacus", "abliteration", "alibaba", "amp", "antigravity", "arcee", "augment", "baseten", "bedrock",
        "byteplus", "cerebras", "chutes", "claude", "clawrouter", "cloudflare", "codebuff", "codex", "cohere",
        "comfy", "commandcode", "copilot", "crof", "crossmodel", "cursor", "deepgram", "deepinfra", "deepseek",
        "devin", "doubao", "elevenlabs", "factory", "fal", "featherless", "fireworks", "gemini", "grok", "groq",
        "huggingface", "jetbrains", "kilo", "kimi", "kiro", "litellm", "llamacpp", "llmproxy", "lmstudio",
        "longcat", "manus", "meta", "microsoft", "mimo", "minimax", "mistral", "novita", "nvidia", "ollama",
        "opencode", "opencodego", "openrouter", "particle", "perplexity", "pi", "pixverse", "poe", "qianfan",
        "qoder", "requesty", "runway", "sakana", "stepfun", "synthetic", "t3chat", "tencent", "together",
        "venice", "vercel", "vertexai", "vllm", "volcengine", "warp", "windsurf", "zai", "zed",
    ]

    private static let aliases: [String: String] = [
        "anthropic": "claude", "amazon-bedrock": "bedrock", "aws-bedrock": "bedrock", "claude-cli": "claude",
        "cloudflare-ai-gateway": "cloudflare", "copilot-proxy": "copilot", "google": "gemini",
        "google-gemini-cli": "gemini", "github-copilot": "copilot", "kilocode": "kilo", "kimi-coding": "kimi",
        "llama-cpp": "llamacpp", "microsoft-foundry": "microsoft", "minimax-portal": "minimax",
        "ollama-cloud": "ollama", "openai": "codex", "moonshot": "kimi", "opencode-go": "opencodego",
        "opencode-zen": "opencode", "qwen": "alibaba", "qwen-token-plan": "alibaba", "stepfun-plan": "stepfun",
        "tencent-tokenhub": "tencent", "tencent-tokenplan": "tencent", "xai": "grok", "xiaomi": "mimo",
        "xiaomi-token-plan": "mimo", "vercel-ai-gateway": "vercel", "vertex-ai": "vertexai", "z-ai": "zai",
    ]

    /// Brand tints as the picker board draws them (Anthropic, OpenAI, Google); every other mark draws in ink.
    private static let tints: [String: Color] = [
        "claude": Color(red: 217 / 255, green: 119 / 255, blue: 87 / 255),
        "codex": Color(red: 16 / 255, green: 163 / 255, blue: 127 / 255),
        "gemini": Color(red: 66 / 255, green: 133 / 255, blue: 244 / 255),
    ]

    static func iconName(for providerID: String) -> String? {
        let normalized = providerID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let icon = self.aliases[normalized] ?? normalized
        if self.names.contains(icon) {
            return icon
        }
        if normalized.hasPrefix("acp-") {
            return self.iconName(for: String(normalized.dropFirst(4)))
        }
        return nil
    }

    static func assetName(for providerID: String) -> String? {
        guard let icon = self.iconName(for: providerID) else { return nil }
        let asset = "ProviderIcon-\(icon)"
        // Package previews and tests run without the app's asset catalog.
        return UIImage(named: asset) == nil ? nil : asset
    }

    static func tint(for providerID: String) -> Color? {
        self.iconName(for: providerID).flatMap { self.tints[$0] }
    }
}
#endif
