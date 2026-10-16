import { describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunExecutionParams,
  resolveRunFastModeForFallbackCandidate,
} from "../auto-reply/reply/agent-runner-utils.js";
import type { FollowupRun } from "../auto-reply/reply/queue.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { streamSimple } from "../llm/stream.js";
import type { Model } from "../llm/types.js";
import { buildProviderStreamFamilyHooks } from "../plugin-sdk/provider-stream.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { resolveFastModeState } from "./fast-mode.js";
import type { StreamFn } from "./runtime/index.js";

const requests = vi.hoisted(() => [] as unknown[]);
vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: (request: unknown) => {
        requests.push(request);
        throw new Error("captured before sending");
      },
    };
  },
}));

const model: Model<"openai-responses"> = {
  id: "speed-fixture",
  name: "Speed fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 1_050_000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function captureRequest(
  cfg: OpenClawConfig,
  fastMode: false | true | "ultrafast" | undefined,
  turnOverride?: Record<string, unknown>,
) {
  const state = resolveFastModeState({
    cfg,
    provider: "openai",
    model: model.id,
    sessionEntry: { fastMode },
  });
  return capturePreparedRequest(cfg, state.requestMode, turnOverride);
}

async function capturePreparedRequest(
  cfg: OpenClawConfig,
  requestMode: false | true | "auto" | "ultrafast" | undefined,
  turnOverride?: Record<string, unknown>,
) {
  const preparedModel = attachModelProviderRuntimePluginHandle(model, {
    provider: "openai",
    modelId: model.id,
    config: cfg,
    plugin: {
      id: "openai",
      label: "Speed fixture",
      auth: [],
      ...buildProviderStreamFamilyHooks("openai-responses-defaults"),
    },
  });
  const agent: { streamFn: StreamFn } = { streamFn: streamSimple };
  applyExtraParamsToAgent(
    agent,
    cfg,
    "openai",
    model.id,
    turnOverride ?? (requestMode === undefined ? undefined : { fastMode: requestMode }),
    undefined,
    undefined,
    undefined,
    preparedModel,
    undefined,
    undefined,
    { nativeWebSearchPolicyContext: { runtimeToolAllowlist: [] } },
  );
  const output = await agent.streamFn(
    preparedModel,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    { apiKey: "synthetic-test-key" },
  );
  expect((await output.result()).errorMessage).toBe("captured before sending");
  return requests.at(-1);
}

describe("configured speed through request assembly", () => {
  it.each(["serviceTier", "service_tier"])(
    "inherits %s without pinning it and honors session selections",
    async (key) => {
      for (const tier of ["flex", "auto", "ultrafast"]) {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              params: { [key === "serviceTier" ? "service_tier" : "serviceTier"]: "priority" },
              models: { "openai/speed-fixture": { params: { [key]: tier } } },
            },
          },
        };
        for (const [fastMode, expected] of [
          [undefined, tier],
          [false, "default"],
          [true, "priority"],
          ["ultrafast", "ultrafast"],
        ] as const) {
          expect(await captureRequest(cfg, fastMode)).toMatchObject({
            service_tier: expected,
            context_management: [
              {
                type: "compaction",
                compact_threshold: expected === "ultrafast" ? 260_000 : 735_000,
              },
            ],
          });
        }
      }
    },
  );

  it.each(["fastMode", "fast_mode"])("honors per-turn %s ahead of stored defaults", async (key) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { params: { fastMode: "ultrafast", serviceTier: "flex" } } },
    };
    for (const [mode, expected] of [
      [false, "default"],
      [true, "priority"],
      ["ultrafast", "ultrafast"],
    ] as const) {
      expect(await captureRequest(cfg, true, { [key]: mode })).toMatchObject({
        service_tier: expected,
      });
    }
  });

  it.each(["fastModeDefault", "fastMode", "fast_mode"])(
    "lets session selections override %s",
    async (key) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            ...(key === "fastModeDefault"
              ? { fastModeDefault: "ultrafast" }
              : { params: { [key]: "ultrafast" } }),
            models: { "openai/speed-fixture": { params: { serviceTier: "flex" } } },
          },
        },
      };
      for (const [fastMode, expected] of [
        [undefined, "ultrafast"],
        [false, "default"],
        [true, "priority"],
        ["ultrafast", "ultrafast"],
      ] as const) {
        expect(await captureRequest(cfg, fastMode)).toMatchObject({ service_tier: expected });
      }
    },
  );
});

describe("fallback speed request provenance", () => {
  it.each(["flex", "auto"])(
    "inherits the candidate's %s tier without leaking the primary speed",
    async (tier) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { models: { "openai/speed-fixture": { params: { serviceTier: tier } } } },
        },
      };
      for (const explicit of [false, true]) {
        const run: FollowupRun["run"] = {
          config: cfg,
          provider: "openai",
          model: "primary-fixture",
          agentId: "main",
          agentDir: "/tmp/speed-default-proof/agent",
          workspaceDir: "/tmp/speed-default-proof/workspace",
          sessionId: "fallback-speed",
          sessionFile: "/tmp/speed-default-proof/session.jsonl",
          timeoutMs: 60_000,
          blockReplyBreak: "text_end",
          skipProviderRuntimeHints: true,
          // The primary's inherited Ultrafast must not become a candidate override.
          fastMode: explicit ? false : "ultrafast",
          fastModeOverride: explicit,
          thinkingCatalog: [],
        };
        const candidate = resolveRunFastModeForFallbackCandidate({
          run,
          config: cfg,
          provider: "openai",
          model: model.id,
        });
        const invocation = await buildEmbeddedRunExecutionParams({
          run: { ...run, ...candidate },
          provider: "openai",
          model: model.id,
          runId: "fallback-speed-run",
          sessionCtx: {},
          hasRepliedRef: undefined,
        });
        expect(await capturePreparedRequest(invocation.config, invocation.fastMode)).toMatchObject({
          service_tier: explicit ? "default" : tier,
        });
      }
    },
  );
});
