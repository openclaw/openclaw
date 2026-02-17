import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Hardcoded provider/auth-method definitions, mirroring
 * src/commands/auth-choice-options.ts :: AUTH_CHOICE_GROUP_DEFS.
 *
 * We duplicate the data here instead of importing because the web app
 * is a separate Next.js build that cannot import from the root `src/`.
 *
 * Auth type guide (must match CLI behaviour):
 *   "api-key"      – simple API key text input
 *   "token"        – paste a setup-token (e.g. Anthropic)
 *   "oauth"        – standard web OAuth (redirect flow) – only Chutes today
 *   "device-flow"  – GitHub device-flow (display code, poll for auth)
 *   "unsupported"  – requires CLI-only infra (plugin auth, custom OAuth)
 */

export type AuthMethod = {
  value: string;
  label: string;
  hint?: string;
  type: "api-key" | "oauth" | "token" | "device-flow" | "unsupported";
  defaultModel?: string;
};

export type ProviderGroup = {
  value: string;
  label: string;
  hint?: string;
  methods: AuthMethod[];
};

const PROVIDERS: ProviderGroup[] = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "Codex OAuth + API key",
    methods: [
      // OpenAI Codex uses a custom OAuth flow (loginOpenAICodexOAuth) that
      // requires a local HTTP server callback – not doable in web UI.
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)", hint: "Requires CLI (custom OAuth flow)", type: "unsupported" },
      { value: "openai-api-key", label: "OpenAI API key", type: "api-key", defaultModel: "openai/gpt-4.1" },
    ],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "setup-token + API key",
    methods: [
      { value: "token", label: "Anthropic token (paste setup-token)", hint: "run `claude setup-token` elsewhere, then paste the token here", type: "token" },
      { value: "apiKey", label: "Anthropic API key", type: "api-key", defaultModel: "anthropic/claude-sonnet-4-5" },
    ],
  },
  {
    value: "chutes",
    label: "Chutes",
    hint: "OAuth",
    methods: [
      { value: "chutes", label: "Chutes (OAuth)", type: "oauth" },
    ],
  },
  {
    value: "google",
    label: "Google",
    hint: "Gemini API key + OAuth",
    methods: [
      { value: "gemini-api-key", label: "Google Gemini API key", type: "api-key", defaultModel: "google/gemini-2.5-pro" },
      // These use plugin-based auth (applyAuthChoicePluginProvider) which
      // requires the full plugin runtime – not available in the web UI.
      { value: "google-antigravity", label: "Google Antigravity OAuth", hint: "Requires CLI (plugin auth)", type: "unsupported" },
      { value: "google-gemini-cli", label: "Google Gemini CLI OAuth", hint: "Requires CLI (plugin auth)", type: "unsupported" },
    ],
  },
  {
    value: "xai",
    label: "xAI (Grok)",
    hint: "API key",
    methods: [
      { value: "xai-api-key", label: "xAI (Grok) API key", type: "api-key", defaultModel: "xai/grok-3" },
    ],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "API key",
    methods: [
      { value: "openrouter-api-key", label: "OpenRouter API key", type: "api-key", defaultModel: "openrouter/anthropic/claude-sonnet-4-5" },
    ],
  },
  {
    value: "copilot",
    label: "Copilot",
    hint: "GitHub + local proxy",
    methods: [
      // GitHub Copilot in CLI uses githubCopilotLoginCommand (device flow).
      // We replicate this with our /api/settings/copilot/start+poll endpoints.
      { value: "github-copilot", label: "GitHub Copilot (GitHub device login)", hint: "Uses GitHub device flow", type: "device-flow", defaultModel: "github-copilot/gpt-4o" },
      // Copilot Proxy uses plugin-based auth – not available in web UI.
      { value: "copilot-proxy", label: "Copilot Proxy (local)", hint: "Requires CLI (plugin auth)", type: "unsupported" },
    ],
  },
  {
    value: "ai-gateway",
    label: "Vercel AI Gateway",
    hint: "API key",
    methods: [
      { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key", type: "api-key" },
    ],
  },
  {
    value: "moonshot",
    label: "Moonshot AI (Kimi K2.5)",
    hint: "Kimi K2.5 + Kimi Coding",
    methods: [
      { value: "moonshot-api-key", label: "Kimi API key (.ai)", type: "api-key" },
      { value: "moonshot-api-key-cn", label: "Kimi API key (.cn)", type: "api-key" },
      { value: "kimi-code-api-key", label: "Kimi Code API key (subscription)", type: "api-key" },
    ],
  },
  {
    value: "together",
    label: "Together AI",
    hint: "API key",
    methods: [
      { value: "together-api-key", label: "Together AI API key", hint: "Access to Llama, DeepSeek, Qwen, and more open models", type: "api-key" },
    ],
  },
  {
    value: "huggingface",
    label: "Hugging Face",
    hint: "Inference API (HF token)",
    methods: [
      { value: "huggingface-api-key", label: "Hugging Face API key (HF token)", hint: "Inference Providers — OpenAI-compatible chat", type: "api-key" },
    ],
  },
  {
    value: "venice",
    label: "Venice AI",
    hint: "Privacy-focused (uncensored models)",
    methods: [
      { value: "venice-api-key", label: "Venice AI API key", hint: "Privacy-focused inference (uncensored models)", type: "api-key" },
    ],
  },
  {
    value: "litellm",
    label: "LiteLLM",
    hint: "Unified LLM gateway (100+ providers)",
    methods: [
      { value: "litellm-api-key", label: "LiteLLM API key", hint: "Unified gateway for 100+ LLM providers", type: "api-key" },
    ],
  },
  {
    value: "synthetic",
    label: "Synthetic",
    hint: "Anthropic-compatible (multi-model)",
    methods: [
      { value: "synthetic-api-key", label: "Synthetic API key", type: "api-key" },
    ],
  },
  {
    value: "custom",
    label: "Custom Provider",
    hint: "Any OpenAI or Anthropic compatible endpoint",
    methods: [
      { value: "custom-api-key", label: "Custom Provider", type: "api-key" },
    ],
  },
];

export async function GET() {
  return NextResponse.json({ providers: PROVIDERS });
}
