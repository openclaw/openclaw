import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const OPENAI_CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";
// Bundled @openai/codex pin, reported when the Codex plugin cannot name the
// binary its turns run; the client-version contract test keeps it equal to
// extensions/codex's exact dependency.
const OPENAI_CODEX_CLIENT_VERSION = "0.160.0";

export type OpenAICodexModelsEndpointContext = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
};

/**
 * ChatGPT model-list URL. The backend gates models on the client version, so
 * discovery reports the Codex binary this process's turns run.
 */
export async function resolveOpenAICodexModelsEndpoint(
  context: OpenAICodexModelsEndpointContext = {},
): Promise<string> {
  // Lazy runtime facade: keeps the Codex plugin surface off provider registration.
  const { resolveCodexClientVersion } =
    await import("openclaw/plugin-sdk/codex-client-version-runtime");
  const clientVersion =
    (await resolveCodexClientVersion({
      config: context.config,
      env: context.env,
      agentDir: context.agentDir,
    })) ?? OPENAI_CODEX_CLIENT_VERSION;
  return `${OPENAI_CODEX_RESPONSES_BASE_URL}/models?client_version=${encodeURIComponent(clientVersion)}`;
}

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

type OpenAIEndpointKind = "unresolved" | "platform" | "chatgpt" | "custom" | "invalid";

const OPENAI_PLATFORM_PATHS = new Set(["/", "/v1", "/v1/"]);
const OPENAI_CHATGPT_PATHS = new Set([
  "/backend-api",
  "/backend-api/",
  "/backend-api/v1",
  "/backend-api/v1/",
  "/backend-api/codex",
  "/backend-api/codex/",
  "/backend-api/codex/v1",
  "/backend-api/codex/v1/",
  "/backend-api/codex/responses",
  "/backend-api/codex/responses/",
]);

/** Classifies exact native endpoints, valid custom URLs, and unsafe/invalid input. */
export function classifyOpenAIBaseUrl(baseUrl: unknown): OpenAIEndpointKind {
  if (baseUrl === undefined || baseUrl === null || baseUrl === "") {
    return "unresolved";
  }
  if (typeof baseUrl !== "string") {
    return "invalid";
  }
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return "unresolved";
  }
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return "invalid";
    }
    const rawHost = url.hostname.toLowerCase();
    const host = rawHost.endsWith(".") ? rawHost.slice(0, -1) : rawHost;
    if (host === "api.openai.com" || host === "chatgpt.com") {
      // Official remote endpoints carry API keys or subscription bearers.
      // Never reinterpret their plaintext form as an eligible native route.
      if (url.protocol !== "https:" || url.port || url.search || url.hash) {
        return "invalid";
      }
      if (host === "api.openai.com" && OPENAI_PLATFORM_PATHS.has(url.pathname)) {
        return "platform";
      }
      if (host === "chatgpt.com" && OPENAI_CHATGPT_PATHS.has(url.pathname)) {
        return "chatgpt";
      }
      return "invalid";
    }
    return "custom";
  } catch {
    return "invalid";
  }
}

export function resolveOpenAIDefaultBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return normalizeOptionalString(env.OPENAI_BASE_URL) ?? OPENAI_API_BASE_URL;
}

export function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  return classifyOpenAIBaseUrl(baseUrl) === "platform";
}

export function isOpenAICodexBaseUrl(baseUrl?: string): boolean {
  return classifyOpenAIBaseUrl(baseUrl) === "chatgpt";
}

export function canonicalizeCodexResponsesBaseUrl(baseUrl?: string): string | undefined {
  return isOpenAICodexBaseUrl(baseUrl) ? OPENAI_CODEX_RESPONSES_BASE_URL : baseUrl;
}
