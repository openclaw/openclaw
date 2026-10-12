import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { supportsClaudeInHistorySystemMessages } from "@openclaw/llm-core/model-contracts/anthropic";
import { stableStringify } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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

export function buildEmbeddedCachePrompt(suffix: string, sections = 48): string {
  const lines = [
    `Reply with exactly CACHE-OK ${suffix}.`,
    "Do not add any extra words or punctuation.",
  ];
  for (let index = 0; index < sections; index += 1) {
    lines.push(
      `Embedded cache section ${index + 1}: deterministic prose about prompt stability, session affinity, request shaping, transport continuity, and cache reuse across identical stable prefixes.`,
    );
  }
  return lines.join("\n");
}

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
          input?: number;
          cacheRead?: number;
          cacheWrite?: number;
          requestIndex?: number;
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
      contracts: { tools: ["cache_probe"] },
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    `module.exports = { id: "cache-proof", register(api) {
      api.registerTool({ name: "cache_probe", label: "Cache probe", description: "Read the next synthetic record. Call with step 1, then step 2, before replying.", parameters: { type: "object", properties: { step: { type: "integer", minimum: 1, maximum: 2 } }, required: ["step"], additionalProperties: false }, execute: async (_id, args) => ({ content: [{ type: "text", text: ("Synthetic cache record for step " + args.step + ": amber birch cedar delta elm fir granite harbor iris juniper kiln linen maple north oak pine quartz reed silver thyme umber violet willow yellow zinc.\\n").repeat(200) }] }) });
      api.on("before_prompt_build", (event) => ({
        prependContext: "Synthetic prefix hook before: " + event.prompt,
        appendContext: "Synthetic prefix hook after: " + event.prompt
      }));
    }};`,
  );
  const instructions = buildStableCachePrefix(
    `${provider}-release-prefix`,
    provider === "openai" ? 2_048 : 96,
  );
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
  config.tools = { allow: ["cache_probe"], toolSearch: false };
  if (provider === "openai") {
    config.agents!.defaults!.bootstrapMaxChars = instructions.length + 4_096;
    config.agents!.defaults!.bootstrapTotalMaxChars = instructions.length + 8_192;
  }
  const host = getAiTransportHost();
  const cache = createPluginCache();
  const requests: Array<{ prefix: ProviderPrefixSnapshot; atMs: number; turn: number }> = [];
  const responseHistory = new Map<string, unknown[]>();
  const captureReads: Promise<void>[] = [];
  const runs: Array<AssistantMessage["usage"]> = [];
  const requestsPerTurn = provider === "openai" ? 3 : 1;
  let turn = 0;
  let wireFailure: Error | undefined;
  configureAiTransportHost({
    ...host,
    buildModelFetch: (...args) => {
      const fetchModel = host.buildModelFetch(...args) ?? globalThis.fetch;
      return async (input, init) => {
        let effectiveInput: unknown[] | undefined;
        try {
          await Promise.all(captureReads);
          if (wireFailure) {
            throw wireFailure;
          }
          expect(
            requests.filter((request) => request.turn === turn).length,
            "no provider retries",
          ).toBeLessThan(requestsPerTurn);
          const payload: unknown = await new Request(input, init).json();
          let effectivePayload = payload;
          if (provider === "openai") {
            assert(payload && typeof payload === "object" && "input" in payload);
            assert(Array.isArray(payload.input));
            const previousId =
              "previous_response_id" in payload ? payload.previous_response_id : undefined;
            if (previousId !== undefined) {
              assert.equal(typeof previousId, "string");
              const inherited = responseHistory.get(previousId as string);
              assert(inherited, "continuation references a captured provider response");
              effectiveInput = [...inherited, ...payload.input];
            } else {
              effectiveInput = payload.input;
            }
            effectivePayload = {
              ...payload,
              input: effectiveInput.map((item) => {
                if (
                  !isRecord(item) ||
                  (item.type !== "function_call" &&
                    !(item.type === "message" && item.role === "assistant"))
                ) {
                  return item;
                }
                // Responses may omit provider item envelopes during replay; call IDs
                // and function-call-output envelopes remain part of the input contract.
                const { id: _id, status: _status, ...inputItem } = item;
                return inputItem;
              }),
            };
          }
          // Stored outputs have provider-owned object key order. Canonicalize the
          // effective context only; the captured wire and every content byte stay intact.
          const prefix = snapshotProviderPrefix(api, JSON.parse(stableStringify(effectivePayload)));
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
            history.includes("Synthetic prefix hook before:") && history.includes(marker),
            "prepend hook reached wire",
          ).toBe(true);
          expect(
            history.includes("Synthetic prefix hook after:") && history.includes(marker),
            "append hook reached wire",
          ).toBe(true);
          if (turn >= 2) {
            expect(
              history.includes("Synthetic skill updated."),
              "refreshed instructions reached history",
            ).toBe(true);
          }
          requests.push({ prefix, atMs, turn });
        } catch (error) {
          wireFailure ??= toErrorObject(error, "Provider prefix capture failed");
          throw error;
        }
        const response = await fetchModel(input, init);
        if (effectiveInput) {
          const inheritedInput = effectiveInput;
          // The stored-response API appends the completed output before the next delta.
          // Capture alongside the original stream without delaying its first event.
          const capture = (async () => {
            const reader = response.clone().body?.getReader();
            assert(reader, "provider response has an event stream");
            const decoder = new TextDecoder();
            let pending = "";
            try {
              for (;;) {
                const chunk = await reader.read();
                assert(!chunk.done, "provider stream ended before response.completed");
                pending += decoder.decode(chunk.value, { stream: true });
                let newline: number;
                while ((newline = pending.indexOf("\n")) >= 0) {
                  const line = pending.slice(0, newline).trimEnd();
                  pending = pending.slice(newline + 1);
                  if (!line.startsWith("data: ") || line === "data: [DONE]") {
                    continue;
                  }
                  const event: unknown = JSON.parse(line.slice(6));
                  if (
                    !event ||
                    typeof event !== "object" ||
                    !("type" in event) ||
                    event.type !== "response.completed"
                  ) {
                    continue;
                  }
                  assert(
                    "response" in event && event.response && typeof event.response === "object",
                  );
                  const completed = event.response;
                  assert(
                    "id" in completed &&
                      typeof completed.id === "string" &&
                      "output" in completed &&
                      Array.isArray(completed.output),
                  );
                  // Completion status and log probabilities are response envelopes,
                  // not replay input. Keep every model-visible field in the inherited context.
                  const output = completed.output.map((item: unknown) => {
                    if (!isRecord(item)) {
                      return item;
                    }
                    if (item.type === "function_call") {
                      const { status: _status, ...call } = item;
                      return {
                        ...call,
                        ...(typeof call.arguments === "string"
                          ? { arguments: JSON.stringify(JSON.parse(call.arguments)) }
                          : {}),
                      };
                    }
                    if (item.type === "message" && Array.isArray(item.content)) {
                      return {
                        ...item,
                        content: item.content.map((block: unknown) => {
                          if (!isRecord(block)) {
                            return block;
                          }
                          const { logprobs: _logprobs, ...content } = block;
                          return content;
                        }),
                      };
                    }
                    return item;
                  });
                  responseHistory.set(completed.id, [...inheritedInput, ...output]);
                  return;
                }
              }
            } finally {
              // Tee cancellation can await the transport branch; terminal capture must not.
              void reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          })().catch((error: unknown) => {
            wireFailure ??= toErrorObject(error, "Provider response capture failed");
          });
          captureReads.push(capture);
        }
        return response;
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
        if (provider !== "openai" || turn === 3) {
          cleanupSessionResources(sessionId);
        }
        const run = await params.probe(config, `release-turn-${turn + 1}`);
        await Promise.all(captureReads);
        if (wireFailure) {
          throw wireFailure;
        }
        expect(requests.length, "captured provider request count").toBe(
          (turn + 1) * requestsPerTurn,
        );
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
            requestGapMs: turn
              ? requests[turn * requestsPerTurn]!.atMs - requests[turn * requestsPerTurn - 1]!.atMs
              : undefined,
          }),
        );
        if (previousPromptTokens !== undefined && provider !== "openai") {
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
    expect(results, "one cache diagnostic per provider request").toHaveLength(4 * requestsPerTurn);
    let previousPromptTokens: number | undefined;
    for (const [index, result] of results.entries()) {
      const usage = result.options;
      const promptTokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
      logLiveCache(
        JSON.stringify({
          scenario: "release-prefix-diagnostic",
          provider,
          turn: Math.floor(index / requestsPerTurn) + 1,
          request: index + 1,
          runId: result.runId,
          input: usage?.input,
          cacheRead: usage?.cacheRead,
          cacheWrite: usage?.cacheWrite,
          promptTokens,
          cachedTokenRatio: promptTokens > 0 ? (usage?.cacheRead ?? 0) / promptTokens : 0,
          requestGapMs: result.options?.requestGapMs,
          providerPrefix: result.options?.providerPrefix ?? "no-cache-drop",
          changes: result.options?.changes?.map((change) => change.code) ?? [],
        }),
      );
      if (previousPromptTokens !== undefined) {
        expect(
          usage?.cacheRead,
          "each continuation reuses at least 80% of the preceding prompt",
        ).toBeGreaterThanOrEqual(Math.floor(previousPromptTokens * 0.8));
      }
      previousPromptTokens = promptTokens;
      expect(
        result.options?.changes?.map((change) => change.code) ?? [],
        "tracked cache input changes",
      ).toEqual([]);
    }
  } catch (error) {
    throw wireFailure ?? toErrorObject(error, "Live prefix scenario failed");
  } finally {
    await Promise.all(captureReads);
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
