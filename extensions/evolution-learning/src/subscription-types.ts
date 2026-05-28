/**
 * subscription-types.ts — 共用訂閱型別（避免 auto-detect 與 registry 相互引用）
 */

export type SubscriptionId =
  // Anthropic
  | "claude-free"
  | "claude-pro"
  | "claude-max-5"
  | "claude-max-20"
  | "claude-api-key"
  // OpenAI
  | "openai-free"
  | "openai-plus"
  | "openai-pro"
  | "openai-api-key"
  | "codex-cli-key"
  // Google
  | "google-one-ai-premium"
  | "google-workspace-ai"
  | "gemini-api-key"
  | "vertex-ai-key"
  // Mistral
  | "mistral-la-plateforme-free"
  | "mistral-api-key"
  // Groq
  | "groq-free"
  | "groq-api-key"
  // xAI
  | "xai-api-key"
  // DeepSeek
  | "deepseek-api-key"
  // Perplexity
  | "perplexity-pro"
  | "perplexity-api-key"
  // Together AI
  | "together-api-key"
  // Cohere
  | "cohere-trial"
  | "cohere-api-key"
  // Tavily
  | "tavily-free"
  | "tavily-starter"
  | "tavily-pro"
  | "tavily-api-key";
