import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { supportsClaudeInHistorySystemMessages } from "@openclaw/llm-core/model-contracts/anthropic";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { expect } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
  type ProviderPrefixSnapshot,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mjs";
import type { OpenClawConfig } from "../config/config.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { clearEmbeddedSessionPromptStates } from "./embedded-agent-runner/session-prompt-state.js";
import {
  buildStableCachePrefix,
  logLiveCache,
  type LiveResolvedModel,
} from "./live-cache-test-support.js";
import { buildUsageWithNoCost } from "./stream-message-shared.js";

function resolveProviderBaseUrl(model: LiveResolvedModel["model"]): string | undefined {
  const candidate = model.baseUrl;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function resolveDefaultProviderBaseUrl(model: LiveResolvedModel["model"]): string {
  if (model.provider === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  if (model.provider === "openai") {
    return "https://api.openai.com/v1";
  }
  return "https://example.invalid/v1";
}

function buildEmbeddedModelDefinition(model: LiveResolvedModel["model"]) {
  // Live model discovery can return partial metadata; embedded runner tests need
  // a complete config model definition.
  const contextWindowCandidate = model.contextWindow;
  const maxTokensCandidate = model.maxTokens;
  const reasoningCandidate = model.reasoning;
  const inputCandidate = model.input;
  const contextWindow =
    typeof contextWindowCandidate === "number" && Number.isFinite(contextWindowCandidate)
      ? Math.max(1, Math.trunc(contextWindowCandidate))
      : 128_000;
  const maxTokens =
    typeof maxTokensCandidate === "number" && Number.isFinite(maxTokensCandidate)
      ? Math.max(1, Math.trunc(maxTokensCandidate))
      : 8_192;
  const input: Array<"text" | "image"> =
    Array.isArray(inputCandidate) &&
    inputCandidate.every((value) => value === "text" || value === "image")
      ? [...inputCandidate]
      : ["text", "image"];
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

function resolveEmbeddedModelApi(
  model: LiveResolvedModel["model"],
): "anthropic-messages" | "openai-responses" {
  return model.provider === "anthropic" ? "anthropic-messages" : "openai-responses";
}

export function normalizeLiveUsage(
  usage:
    | AssistantMessage["usage"]
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined,
): AssistantMessage["usage"] {
  if (!usage) {
    return buildUsageWithNoCost({});
  }
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const totalTokens =
    "totalTokens" in usage && typeof usage.totalTokens === "number"
      ? usage.totalTokens
      : "total" in usage && typeof usage.total === "number"
        ? usage.total
        : input + output;
  const cost =
    "cost" in usage && usage.cost
      ? usage.cost
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
  };
}

export function buildEmbeddedRunnerConfig(
  params: LiveResolvedModel & {
    agentDir: string;
    cacheRetention: "none" | "short" | "long";
    compactionModel?: string;
    modelAlias?: string;
    transport?: "sse" | "websocket";
  },
): OpenClawConfig {
  const provider = params.model.provider;
  const modelKey = `${provider}/${params.model.id}`;
  const providerBaseUrl =
    resolveProviderBaseUrl(params.model) ?? resolveDefaultProviderBaseUrl(params.model);
  return {
    models: {
      providers: {
        [provider]: {
          api: resolveEmbeddedModelApi(params.model),
          auth: "api-key",
          apiKey: params.apiKey,
          baseUrl: providerBaseUrl,
          models: [buildEmbeddedModelDefinition(params.model)],
        },
      },
    },
    agents: {
      entries: { main: { agentDir: params.agentDir } },
      defaults: {
        models: {
          [modelKey]: {
            ...(params.modelAlias ? { alias: params.modelAlias } : {}),
            params: {
              cacheRetention: params.cacheRetention,
              ...(params.transport ? { transport: params.transport } : {}),
            },
          },
        },
        ...(params.compactionModel ? { compaction: { model: params.compactionModel } } : {}),
      },
    },
  };
}

export async function runEmbeddedReleasePrefixScenario(
  params: LiveResolvedModel & {
    provider: "openai" | "anthropic";
    sessionId: string;
    agentDir: string;
    workspaceDir: string;
    probe: (config: OpenClawConfig, suffix: string) => Promise<AssistantMessage["usage"]>;
    readTraceEvents: () => Promise<
      Array<{
        runId?: string;
        stage?: string;
        options?: {
          requestGapMs?: number;
          providerPrefix?: string;
          changes?: Array<{ code?: string; detail?: string }>;
        };
      }>
    >;
  },
): Promise<void> {
  const { provider, sessionId, agentDir, workspaceDir } = params;
  const fixture = { apiKey: params.apiKey, model: params.model };
  const api = provider === "openai" ? "openai-responses" : "anthropic-messages";
  if (provider === "anthropic") {
    expect(supportsClaudeInHistorySystemMessages(fixture.model), "in-history Claude model").toBe(
      true,
    );
  }
  await fs.mkdir(workspaceDir, { recursive: true });
  const pluginDir = path.join(workspaceDir, "cache-proof-plugin");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "cache-proof",
      activation: { onStartup: true },
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    `module.exports = { id: "cache-proof", register(api) {
      api.on("before_prompt_build", (event) => ({
        prependContext: "Synthetic prefix hook before: " + event.prompt,
        appendContext: "Synthetic prefix hook after: " + event.prompt
      }));
    }};`,
  );
  const instructions = buildStableCachePrefix(`${provider}-release-prefix`, 96);
  const config = buildEmbeddedRunnerConfig({
    ...fixture,
    agentDir,
    cacheRetention: "short",
    transport: "sse",
  });
  config.plugins = {
    allow: [provider, "cache-proof"],
    load: { paths: [pluginDir] },
    entries: { "cache-proof": { enabled: true, hooks: { allowConversationAccess: true } } },
    slots: { memory: "none" },
  };
  const host = getAiTransportHost();
  const cache = createPluginCache();
  const requests: Array<{ prefix: ProviderPrefixSnapshot; atMs: number }> = [];
  const runs: Array<AssistantMessage["usage"]> = [];
  let turn = 0;
  let wireFailure: Error | undefined;
  configureAiTransportHost({
    ...host,
    buildModelFetch: (...args) => {
      const fetchModel = host.buildModelFetch(...args) ?? globalThis.fetch;
      return async (input, init) => {
        try {
          expect(requests.length, "exactly one provider request per turn; no retries").toBe(turn);
          const payload: unknown = await new Request(input, init).json();
          const prefix = snapshotProviderPrefix(api, payload);
          const atMs = Date.now();
          const previous = requests.at(-1);
          if (previous) {
            assertStableProviderPrefix(previous.prefix, prefix, {
              label: `${provider} release turn ${turn + 1}`,
            });
            expect(
              atMs - previous.atMs,
              "provider request gap below cache-expiry noise",
            ).toBeLessThan(30_000);
          }
          const history = prefix.history.join("\n");
          const marker = `Reply with exactly CACHE-OK release-turn-${turn + 1}.`;
          expect(
            history.includes(`Synthetic prefix hook before: ${marker}`),
            "prepend hook reached wire",
          ).toBe(true);
          expect(
            history.includes(`Synthetic prefix hook after: ${marker}`),
            "append hook reached wire",
          ).toBe(true);
          if (turn >= 2) {
            expect(
              history.includes("Synthetic skill updated."),
              "refreshed instructions reached history",
            ).toBe(true);
          }
          requests.push({ prefix, atMs });
        } catch (error) {
          wireFailure ??= toErrorObject(error, "Provider prefix capture failed");
          throw error;
        }
        return fetchModel(input, init);
      };
    },
  });
  try {
    await withPluginCache(cache, async () => {
      // Direct runner callers need the same hook activation owned by Gateway startup.
      await loadAndActivateRootPluginRegistry({ config, workspaceDir, throwOnLoadError: true });
      for (turn = 0; turn < 4; turn += 1) {
        const revision = turn < 2 ? "initial" : "updated";
        await fs.writeFile(
          path.join(workspaceDir, "AGENTS.md"),
          `${instructions}\n\n## Skills\nSynthetic skill ${revision}.\n## Temporal Context\nSynthetic day ${revision}.\n## Runtime\nSynthetic runtime ${revision}.\n`,
        );
        if (turn === 3) {
          // Rehydrate the persisted prompt projection instead of retaining its warm cache.
          clearEmbeddedSessionPromptStates([sessionId]);
        }
        // A cold transport sends the complete history instead of an HTTP response-id delta.
        cleanupSessionResources(sessionId);
        const run = await params.probe(config, `release-turn-${turn + 1}`);
        if (wireFailure) {
          throw wireFailure;
        }
        expect(requests.length, "captured provider request count").toBe(turn + 1);
        const previous = runs.at(-1);
        const previousPromptTokens = previous
          ? previous.input + previous.cacheRead + previous.cacheWrite
          : undefined;
        logLiveCache(
          JSON.stringify({
            scenario: "release-prefix",
            provider,
            turn: turn + 1,
            input: run.input,
            cacheRead: run.cacheRead,
            cacheWrite: run.cacheWrite,
            output: run.output,
            previousPromptTokens,
            requestGapMs: turn ? requests[turn]!.atMs - requests[turn - 1]!.atMs : undefined,
          }),
        );
        if (previousPromptTokens !== undefined) {
          expect(previousPromptTokens, "provider minimum cacheable prefix").toBeGreaterThan(4_096);
          expect(run.cacheRead, "reuse at least 80% of the previous prompt").toBeGreaterThanOrEqual(
            Math.floor(previousPromptTokens * 0.8),
          );
        }
        runs.push(run);
      }
    });
    const events = await params.readTraceEvents();
    const results = events.filter((event) => event.stage === "cache:result");
    expect(results, "one cache diagnostic per provider request").toHaveLength(4);
    for (const result of results) {
      logLiveCache(
        JSON.stringify({
          scenario: "release-prefix-diagnostic",
          provider,
          runId: result.runId,
          requestGapMs: result.options?.requestGapMs,
          providerPrefix: result.options?.providerPrefix ?? "no-cache-drop",
          changes: result.options?.changes?.map((change) => change.code) ?? [],
        }),
      );
      expect(
        result.options?.changes?.map((change) => change.code) ?? [],
        "tracked cache input changes",
      ).toEqual([]);
    }
  } catch (error) {
    throw wireFailure ?? toErrorObject(error, "Live prefix scenario failed");
  } finally {
    configureAiTransportHost(host);
    try {
      cleanupSessionResources(sessionId);
    } finally {
      clearEmbeddedSessionPromptStates([sessionId]);
      try {
        await clearActivePluginRegistry();
      } finally {
        await retirePluginCache(cache);
      }
    }
  }
}
