import path from "node:path";
import { expect } from "vitest";
import { acquireGatewayTestClient } from "../../../../test/helpers/gateway-client.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { GatewayClient } from "../../../gateway/client.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../../utils/message-channel.js";

export type AgentPayload = {
  status?: string;
  result?: unknown;
};

export const REQUEST_TIMEOUT_MS = 8 * 60_000;
const WAIT_TIMEOUT_MS = 8 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type LiveSubagentModelConfig =
  | { modelKey: string; provider: "ollama" }
  | { modelKey: string; provider: "openai"; requiredEnv: "OPENAI_API_KEY" }
  | {
      modelKey: string;
      provider: "google";
      requiredEnv: "GEMINI_API_KEY" | "GOOGLE_API_KEY";
    };
type LiveSubagentModelProviders = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

export function resolveLiveSubagentModelConfig(): LiveSubagentModelConfig {
  const modelKey = process.env.OPENCLAW_LIVE_SUBAGENT_E2E_MODEL?.trim() || "openai/gpt-5.6-luna";
  if (modelKey.startsWith("ollama/")) {
    return { modelKey, provider: "ollama" };
  }
  if (modelKey.startsWith("google/")) {
    return {
      modelKey,
      provider: "google",
      requiredEnv: process.env.GEMINI_API_KEY?.trim() ? "GEMINI_API_KEY" : "GOOGLE_API_KEY",
    };
  }
  return { modelKey, provider: "openai", requiredEnv: "OPENAI_API_KEY" };
}

export function requireLiveSubagentAuth(config: LiveSubagentModelConfig): void {
  // Live E2E runs need the provider credential that matches the selected model
  // family; fail early before gateway startup.
  if (config.provider !== "ollama") {
    expect(process.env[config.requiredEnv]?.trim(), config.requiredEnv).toBeTruthy();
  }
}

export function liveSubagentConfig(
  modelKey: string,
  workspace: string,
  port: number,
  token: string,
  options?: {
    queue?: NonNullable<OpenClawConfig["messages"]>["queue"];
    toolAllow?: string[];
  },
): OpenClawConfig {
  const providerConfig = resolveLiveSubagentModelConfig();
  const modelId = modelKey.replace(/^(openai|google|ollama)\//u, "");
  const providers: LiveSubagentModelProviders = {};
  if (providerConfig.provider === "ollama") {
    providers.ollama = {
      api: "ollama" as const,
      agentRuntime: { id: "openclaw" },
      baseUrl:
        process.env.OPENCLAW_LIVE_SUBAGENT_E2E_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
      apiKey: "ollama-local",
      timeoutSeconds: 300,
      models: [
        {
          id: modelId,
          name: modelId,
          api: "ollama" as const,
          agentRuntime: { id: "openclaw" },
          input: ["text" as const],
          reasoning: false,
          contextWindow: 32_768,
          maxTokens: 2_048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          params: { num_ctx: 32_768, keep_alive: "5m" },
        },
      ],
    };
  } else if (providerConfig.provider === "google") {
    providers.google = {
      api: "google-generative-ai" as const,
      agentRuntime: { id: "openclaw" },
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: {
        source: "env" as const,
        provider: "default" as const,
        id: providerConfig.requiredEnv,
      },
      timeoutSeconds: 300,
      models: [
        {
          id: modelId,
          name: modelId,
          api: "google-generative-ai" as const,
          agentRuntime: { id: "openclaw" },
          input: ["text" as const],
          reasoning: true,
          contextWindow: 1_048_576,
          maxTokens: 8_192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
  } else {
    providers.openai = {
      api: "openai-responses" as const,
      agentRuntime: { id: "openclaw" },
      apiKey: {
        source: "env" as const,
        provider: "default" as const,
        id: "OPENAI_API_KEY",
      },
      baseUrl: "https://api.openai.com/v1",
      timeoutSeconds: 300,
      models: [
        {
          id: modelId,
          name: modelId,
          api: "openai-responses" as const,
          agentRuntime: { id: "openclaw" },
          input: ["text" as const],
          reasoning: true,
          contextWindow: 1_047_576,
          maxTokens: 8_192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
  }
  return {
    gateway: {
      mode: "local",
      port,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
    },
    plugins: { enabled: providerConfig.provider === "ollama" },
    tools: { allow: options?.toolAllow ?? ["sessions_spawn", "sessions_yield", "subagents"] },
    ...(options?.queue ? { messages: { queue: options.queue } } : {}),
    models: {
      providers,
    },
    agents: {
      defaults: {
        workspace,
        model: { primary: modelKey },
        models: { [modelKey]: { agentRuntime: { id: "openclaw" }, params: { maxTokens: 1024 } } },
        sandbox: { mode: "off" },
        subagents: {
          allowAgents: ["*"],
          runTimeoutSeconds: 300,
          announceTimeoutMs: 300_000,
          archiveAfterMinutes: 60,
        },
      },
    },
  };
}

export async function waitFor<T>(
  label: string,
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<T> {
  const started = Date.now();
  let lastValue: T | undefined;
  while (Date.now() - started < timeoutMs) {
    lastValue = await fn();
    if (lastValue !== undefined) {
      return lastValue;
    }
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function createGatewayClient(params: {
  port: number;
  token: string;
  onEvent?: ConstructorParameters<typeof GatewayClient>[0]["onEvent"];
}): Promise<GatewayClient> {
  return acquireGatewayTestClient(
    {
      url: `ws://127.0.0.1:${params.port}`,
      token: params.token,
      deviceIdentity: null,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin"],
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onEvent: params.onEvent,
    },
    {
      timeoutMs: 30_000,
      timeoutMessage: "Live subagent Gateway connection timed out",
      closeMessage: "Live subagent Gateway closed before hello",
    },
  );
}

export function createLiveSubagentState(
  label: string,
  env: Record<string, string | undefined> = {},
) {
  return createOpenClawTestState({
    label,
    layout: "split",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      // Agent admission needs the reply runtime published by normal startup.
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
      OPENCLAW_PLUGINS_PATHS: undefined,
      ...env,
    },
  });
}
