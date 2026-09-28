// Hermes environment credential catalog.

export type SecretCredentialMode = "api_key" | "token";

export type SecretMapping = {
  envVar: string;
  provider: string;
  profileId: string;
  mode?: SecretCredentialMode;
};

export const SECRET_MAPPINGS: readonly SecretMapping[] = [
  ...(
    [
      ["OPENAI_API_KEY", "openai"],
      ["ANTHROPIC_API_KEY", "anthropic"],
      ["OPENROUTER_API_KEY", "openrouter"],
      ["GOOGLE_API_KEY", "google"],
      ["GEMINI_API_KEY", "google"],
      ["GROQ_API_KEY", "groq"],
      ["XAI_API_KEY", "xai"],
      ["MISTRAL_API_KEY", "mistral"],
      ["DEEPSEEK_API_KEY", "deepseek"],
      ["ZAI_API_KEY", "zai"],
      ["Z_AI_API_KEY", "zai"],
      ["GLM_API_KEY", "zai"],
      ["KIMI_API_KEY", "kimi"],
      ["KIMICODE_API_KEY", "kimi"],
      ["KIMI_CODING_API_KEY", "kimi"],
      ["MOONSHOT_API_KEY", "moonshot"],
      ["KIMI_CN_API_KEY", "moonshot"],
      ["MINIMAX_API_KEY", "minimax"],
      ["MINIMAX_CN_API_KEY", "minimax"],
      ["MINIMAX_CODING_API_KEY", "minimax"],
      ["DASHSCOPE_API_KEY", "qwen"],
      ["QWEN_API_KEY", "qwen"],
      ["MODELSTUDIO_API_KEY", "qwen"],
      ["KILOCODE_API_KEY", "kilocode"],
      ["AI_GATEWAY_API_KEY", "vercel-ai-gateway"],
      ["HF_TOKEN", "huggingface"],
      ["HUGGINGFACE_HUB_TOKEN", "huggingface"],
      ["TOGETHER_API_KEY", "together"],
      ["FIREWORKS_API_KEY", "fireworks"],
      ["DEEPINFRA_API_KEY", "deepinfra"],
      ["CEREBRAS_API_KEY", "cerebras"],
      ["NVIDIA_API_KEY", "nvidia"],
      ["VENICE_API_KEY", "venice"],
      ["XIAOMI_API_KEY", "xiaomi"],
      ["ALIBABA_API_KEY", "qwen"],
      ["ALIBABA_CODING_PLAN_API_KEY", "qwen"],
      ["ARCEEAI_API_KEY", "arcee"],
      ["CHUTES_API_KEY", "chutes"],
      ["CLOUDFLARE_AI_GATEWAY_API_KEY", "cloudflare-ai-gateway"],
      ["QIANFAN_API_KEY", "qianfan"],
      ["OPENCODE_API_KEY", "opencode"],
      ["OPENCODE_API_KEY", "opencode-go"],
      ["OPENCODE_ZEN_API_KEY", "opencode"],
      ["OPENCODE_ZEN_API_KEY", "opencode-go"],
      ["OPENCODE_GO_API_KEY", "opencode-go"],
    ] as const
  ).map(([envVar, provider]) => ({
    envVar,
    provider,
    profileId: `${provider}:hermes-import`,
  })),
  {
    envVar: "COPILOT_GITHUB_TOKEN",
    provider: "github-copilot",
    profileId: "github-copilot:github",
    mode: "token",
  },
];
