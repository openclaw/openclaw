import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveLiveDirectModel } from "./live-cache-test-support.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { runEmbeddedPiAgent } from "./pi-embedded-runner.js";

const LIVE = isLiveTestEnabled();
const SESSIONS_YIELD_TRUTH_LIVE = isTruthyEnvValue(
  process.env.OPENCLAW_LIVE_SESSIONS_YIELD_COMPLETION_TRUTH,
);
const describeLive = LIVE && SESSIONS_YIELD_TRUTH_LIVE ? describe : describe.skip;

const LIVE_TIMEOUT_MS = 4 * 60_000;
const MODEL_RESOLVE_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 120_000;
const YIELD_MESSAGE = "LIVE-SMOKE waiting for worker completion truth";
const REQUESTED_PROVIDER =
  process.env.OPENCLAW_LIVE_SESSIONS_YIELD_COMPLETION_TRUTH_PROVIDER?.trim().toLowerCase();
const EXPLICIT_PROVIDER_ID =
  process.env.OPENCLAW_LIVE_SESSIONS_YIELD_COMPLETION_TRUTH_PROVIDER_ID?.trim();
const EXPLICIT_MODEL_ID = process.env.OPENCLAW_LIVE_SESSIONS_YIELD_COMPLETION_TRUTH_MODEL?.trim();
const EXPLICIT_API_KEY = process.env.OPENCLAW_LIVE_SESSIONS_YIELD_COMPLETION_TRUTH_API_KEY?.trim();
const EXPLICIT_BASE_URL =
  process.env.OPENCLAW_LIVE_SESSIONS_YIELD_COMPLETION_TRUTH_BASE_URL?.trim();
const EXPLICIT_API = process.env.OPENCLAW_LIVE_SESSIONS_YIELD_COMPLETION_TRUTH_API?.trim() as
  | "anthropic-messages"
  | "openai-responses"
  | undefined;

type ResolvedFixture = {
  model: {
    provider: string;
    id: string;
    api: "anthropic-messages" | "openai-responses";
    baseUrl?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    input?: Array<"text" | "image">;
  };
  apiKey: string;
};

function resolveDefaultProviderBaseUrl(model: ResolvedFixture["model"]): string {
  if (model.provider === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  return "https://api.openai.com/v1";
}

function resolveProviderBaseUrl(model: ResolvedFixture["model"]): string {
  const candidate = (model as { baseUrl?: unknown }).baseUrl;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : resolveDefaultProviderBaseUrl(model);
}

function resolveEmbeddedModelApi(
  model: ResolvedFixture["model"],
): "anthropic-messages" | "openai-responses" {
  return model.api;
}

function buildEmbeddedModelDefinition(model: ResolvedFixture["model"]) {
  const contextWindowCandidate = (model as { contextWindow?: unknown }).contextWindow;
  const maxTokensCandidate = (model as { maxTokens?: unknown }).maxTokens;
  const reasoningCandidate = (model as { reasoning?: unknown }).reasoning;
  const inputCandidate = (model as { input?: unknown }).input;
  const contextWindow =
    typeof contextWindowCandidate === "number" && Number.isFinite(contextWindowCandidate)
      ? Math.max(1, Math.trunc(contextWindowCandidate))
      : 128_000;
  const maxTokens =
    typeof maxTokensCandidate === "number" && Number.isFinite(maxTokensCandidate)
      ? Math.max(1, Math.trunc(maxTokensCandidate))
      : 8_192;
  const input =
    Array.isArray(inputCandidate) &&
    inputCandidate.every((value) => value === "text" || value === "image")
      ? [...inputCandidate]
      : (["text", "image"] as Array<"text" | "image">);
  return {
    id: model.id,
    name: model.id,
    api: resolveEmbeddedModelApi(model),
    reasoning: typeof reasoningCandidate === "boolean" ? reasoningCandidate : false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

function buildEmbeddedRunnerConfig(params: ResolvedFixture): OpenClawConfig {
  const provider = params.model.provider;
  const modelKey = `${provider}/${params.model.id}`;
  return {
    models: {
      providers: {
        [provider]: {
          api: resolveEmbeddedModelApi(params.model),
          auth: "api-key",
          apiKey: params.apiKey,
          baseUrl: resolveProviderBaseUrl(params.model),
          models: [buildEmbeddedModelDefinition(params.model)],
        },
      },
    },
    agents: {
      defaults: {
        models: {
          [modelKey]: {
            params: {
              temperature: 0,
            },
          },
        },
      },
    },
  };
}

async function resolveFixture(): Promise<ResolvedFixture> {
  if (EXPLICIT_PROVIDER_ID && EXPLICIT_MODEL_ID && EXPLICIT_API_KEY && EXPLICIT_API) {
    return {
      model: {
        provider: EXPLICIT_PROVIDER_ID,
        id: EXPLICIT_MODEL_ID,
        api: EXPLICIT_API,
        baseUrl: EXPLICIT_BASE_URL,
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: EXPLICIT_API === "anthropic-messages",
        input: ["text", "image"],
      },
      apiKey: EXPLICIT_API_KEY,
    };
  }

  const provider = REQUESTED_PROVIDER === "openai" ? "openai" : "anthropic";
  if (provider === "openai") {
    const resolved = await resolveLiveDirectModel({
      provider: "openai",
      api: "openai-responses",
      envVar: "OPENCLAW_LIVE_SESSIONS_YIELD_COMPLETION_TRUTH_MODEL",
      preferredModelIds: ["gpt-5.4", "gpt-5.5"],
    });
    return {
      model: {
        provider: resolved.model.provider,
        id: resolved.model.id,
        api: "openai-responses",
        baseUrl: (resolved.model as { baseUrl?: string }).baseUrl,
        contextWindow: (resolved.model as { contextWindow?: number }).contextWindow,
        maxTokens: (resolved.model as { maxTokens?: number }).maxTokens,
        reasoning: (resolved.model as { reasoning?: boolean }).reasoning,
        input: (resolved.model as { input?: Array<"text" | "image"> }).input,
      },
      apiKey: resolved.apiKey,
    };
  }
  const resolved = await resolveLiveDirectModel({
    provider: "anthropic",
    api: "anthropic-messages",
    envVar: "OPENCLAW_LIVE_SESSIONS_YIELD_COMPLETION_TRUTH_MODEL",
    preferredModelIds: ["claude-sonnet-4-6", "claude-opus-4-6"],
  });
  return {
    model: {
      provider: resolved.model.provider,
      id: resolved.model.id,
      api: "anthropic-messages",
      baseUrl: (resolved.model as { baseUrl?: string }).baseUrl,
      contextWindow: (resolved.model as { contextWindow?: number }).contextWindow,
      maxTokens: (resolved.model as { maxTokens?: number }).maxTokens,
      reasoning: (resolved.model as { reasoning?: boolean }).reasoning,
      input: (resolved.model as { input?: Array<"text" | "image"> }).input,
    },
    apiKey: resolved.apiKey,
  };
}

function logLiveStep(message: string): void {
  process.stderr.write(`[live-sessions-yield-truth] ${message}\n`);
}

describeLive("runEmbeddedPiAgent sessions_yield completion truth (live)", () => {
  let fixture: ResolvedFixture;
  let tempRoot: string;
  let agentDir: string;
  let workspaceDir: string;
  let sessionFile: string;

  beforeAll(async () => {
    fixture = await resolveFixture();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-yield-truth-"));
    agentDir = path.join(tempRoot, "agent");
    workspaceDir = path.join(tempRoot, "workspace");
    sessionFile = path.join(tempRoot, "session.jsonl");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    logLiveStep(`model=${fixture.model.provider}/${fixture.model.id}`);
  }, MODEL_RESOLVE_TIMEOUT_MS);

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it(
    "resolves explicit toolResult completion truth for a real sessions_yield turn",
    async () => {
      const result = await runEmbeddedPiAgent({
        sessionId: `live-yield-truth-${Date.now()}`,
        sessionKey: `live-yield-truth:${Date.now()}`,
        sessionFile,
        workspaceDir,
        agentDir,
        config: buildEmbeddedRunnerConfig(fixture),
        provider: fixture.model.provider,
        model: fixture.model.id,
        timeoutMs: RUN_TIMEOUT_MS,
        runId: `run-live-yield-truth-${Date.now()}`,
        prompt: [
          "Call the sessions_yield tool exactly once.",
          `Use this exact message: ${YIELD_MESSAGE}`,
          "Do not call any other tool.",
          "Do not answer with normal text.",
        ].join("\n"),
        extraSystemPrompt:
          "For this live smoke, your only valid action is one sessions_yield tool call with the exact requested message.",
        toolsAllow: ["sessions_yield"],
        cleanupBundleMcpOnRunEnd: true,
      });

      expect(result.meta.stopReason).toBe("end_turn");
      expect(result.meta.pendingToolCalls).toBeUndefined();
      expect(result.meta.completion?.truth).toMatchObject({
        source: "sessions_yield",
        status: "yielded",
        message: YIELD_MESSAGE,
      });
      expect(result.meta.completion?.truth).not.toHaveProperty("sessionId");
      expect(result.meta.completion?.truth).not.toHaveProperty("toolCallId");
      expect(result.meta.completion?.truthSelection).toMatchObject({
        source: "toolResult",
        confidence: "high",
      });
    },
    LIVE_TIMEOUT_MS,
  );
});
