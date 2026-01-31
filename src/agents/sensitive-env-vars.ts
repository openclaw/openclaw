// List of environment variables that contain sensitive information (API keys, tokens, passwords)
// and should be scrubbed from the environment passed to child processes (e.g., 'exec' tool).
export const SENSITIVE_ENV_VARS = new Set([
  // ClawDBot internal
  "CLAWDBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_PASSWORD",
  "CLAWDBOT_LIVE_SETUP_TOKEN",
  "CLAWDBOT_LIVE_SETUP_TOKEN_VALUE",
  "CLAWDBOT_LIVE_SETUP_TOKEN_PROFILE",

  // LLM/API Keys (from src/agents/model-auth.ts)
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "DEEPGRAM_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY", // vercel-ai-gateway
  "MOONSHOT_API_KEY",
  "KIMICODE_API_KEY",
  "MINIMAX_API_KEY",
  "SYNTHETIC_API_KEY",
  "VENICE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "CHUTES_API_KEY",
  "CHUTES_OAUTH_TOKEN",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "QWEN_PORTAL_API_KEY",
  "QWEN_OAUTH_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",

  // OAuth Client Secrets
  "CHUTES_CLIENT_ID",
  "CHUTES_CLIENT_SECRET",

  // AWS Credentials (from src/agents/model-auth.ts)
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_PROFILE",
]);

/**
 * Filters an environment object to remove sensitive keys.
 * @param env The environment object to clean.
 * @returns A new environment object with sensitive keys removed.
 */
export function scrubSensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const key in env) {
    if (Object.prototype.hasOwnProperty.call(env, key) && !SENSITIVE_ENV_VARS.has(key)) {
      cleanEnv[key] = env[key];
    }
  }
  return cleanEnv;
}
