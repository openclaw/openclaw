// Proves the pinned fallback decision survives the complete reply-entry path.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withReplyDispatcher } from "../auto-reply/dispatch-dispatcher.js";
import { buildCommandTestParams } from "../auto-reply/reply/commands.test-harness.js";
import type { ReplyDispatchKind } from "../auto-reply/reply/reply-dispatcher.types.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import {
  makeModelFallbackConfig,
  withModelFallbackWorkspace,
  writeFallbackAuthStore,
  writeFallbackMultiProfileAuthStore,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const runEmbeddedAttemptMock =
  vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
const emptyPluginRegistry = createEmptyPluginRegistry();
const suspendSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const { computeBackoffMock, sleepWithAbortMock } = vi.hoisted(() => ({
  computeBackoffMock: vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 321,
  ),
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
}));

function installReplyEntryMocks() {
  vi.doMock("../plugins/runtime.js", () => ({
    getActivePluginRegistry: () => null,
    getActivePluginRegistryWorkspaceDir: () => undefined,
    getPluginRegistryForContext: () => emptyPluginRegistry,
    requireActivePluginRegistry: () => emptyPluginRegistry,
  }));
  vi.doMock("./harness/runtime-plugin.js", () => ({
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
  }));
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
  });
  installEmbeddedRunnerBackoffE2eMocks({
    computeBackoff: (policy, attempt) => computeBackoffMock(policy, attempt),
    sleepWithAbort: (ms, abortSignal) => sleepWithAbortMock(ms, abortSignal),
  });
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  vi.doMock("./session-suspension.js", async () => {
    const actual =
      await vi.importActual<typeof import("./session-suspension.js")>("./session-suspension.js");
    return { ...actual, suspendSession: suspendSessionMock };
  });
}

let getReplyFromConfig: typeof import("../auto-reply/reply/get-reply.js").getReplyFromConfig;
let withFullRuntimeReplyConfig: typeof import("../auto-reply/reply/get-reply-fast-path.js").withFullRuntimeReplyConfig;
let createReplyDispatcher: typeof import("../auto-reply/reply/reply-dispatcher.js").createReplyDispatcher;
const RATE_LIMIT_ERROR_MESSAGE = "rate limit exceeded";
const reservedProviders = ["refresh", "access", "cancel", "choice"];
const completedWriteToolMetas = [
  {
    toolName: "write",
    toolCallId: "write-report",
    meta: "path=report.txt",
    replaySafe: false,
    isError: false,
  },
];

beforeAll(async () => {
  installReplyEntryMocks();
  ({ getReplyFromConfig } = await import("../auto-reply/reply/get-reply.js"));
  ({ withFullRuntimeReplyConfig } = await import("../auto-reply/reply/get-reply-fast-path.js"));
  ({ createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js"));
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
  resetFallbackSkipCacheForTest();
  runEmbeddedAttemptMock.mockReset();
  suspendSessionMock.mockClear();
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

function countProviderAttempts(provider: string): number {
  return runEmbeddedAttemptMock.mock.calls.filter(([params]) => params.provider === provider)
    .length;
}

describe("getReplyFromConfig fallback availability", () => {
  it.each([
    {
      title: "returns the pinned rate-limit surface through the reply entry",
      provider: "openai",
      errorMessage: RATE_LIMIT_ERROR_MESSAGE,
      toolMetas: [],
      loginCommand: undefined,
    },
    {
      title: "delivers a returned API-key error after a write without OAuth sign-in",
      provider: "openai",
      errorMessage: "401 invalid API key",
      toolMetas: completedWriteToolMetas,
      loginCommand: undefined,
    },
    ...["openai", "xai", "minimax-portal"].map((provider) => ({
      title: `delivers returned ${provider} OAuth recovery after a write`,
      provider,
      errorMessage: `OAuth token refresh failed for ${provider}: refresh_token_invalidated`,
      toolMetas: completedWriteToolMetas,
      loginCommand: `/login ${provider}`,
    })),
    ...reservedProviders.map((provider) => ({
      title: `dispatches delivered ${provider} OAuth recovery into the provider chooser`,
      provider,
      errorMessage: `OAuth token refresh failed for ${provider}: refresh_token_invalidated`,
      toolMetas: completedWriteToolMetas,
      loginCommand: "/login",
    })),
  ])("$title", async ({ provider, errorMessage, toolMetas, loginCommand }) => {
    // Pre-fix this chain returned "The AI service is temporarily rate-limited. Please try again
    // in a moment." because run preparation rebuilt fallbackConfigured from config defaults instead
    // of carrying the disabled model-fallback availability into the embedded runner.
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      if (provider === "openai") {
        await writeFallbackMultiProfileAuthStore(agentDir);
      } else {
        await writeFallbackAuthStore(agentDir, undefined, { primaryProvider: provider });
      }
      const authStore = ensureAuthProfileStore(agentDir, { syncExternalCli: false });
      const baseConfig = makeModelFallbackConfig(provider);
      const groqProvider = baseConfig.models?.providers?.groq;
      if (!groqProvider) {
        throw new Error("expected fallback provider fixture");
      }
      const sessionKey = "agent:test:telegram:111";
      const storePath = path.join(path.dirname(agentDir), "sessions.json");
      const cfg: OpenClawConfig = {
        ...baseConfig,
        agents: {
          ...baseConfig.agents,
          defaults: {
            ...baseConfig.agents?.defaults,
            workspace: workspaceDir,
            model: { primary: `${provider}/mock-1`, fallbacks: ["anthropic/mock-2"] },
          },
          list: [{ id: "test", agentDir, workspace: workspaceDir }],
        },
        models: {
          ...baseConfig.models,
          providers: {
            ...baseConfig.models?.providers,
            anthropic: { ...groqProvider, baseUrl: "https://example.com/anthropic" },
          },
        },
        session: { store: storePath },
      };
      if (reservedProviders.includes(provider)) {
        const pluginDir = path.join(workspaceDir, "reserved-recovery");
        await fs.mkdir(pluginDir);
        await fs.writeFile(
          path.join(pluginDir, "index.cjs"),
          "module.exports = { register() {} };\n",
        );
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: "reserved-recovery",
            configSchema: { type: "object", additionalProperties: false, properties: {} },
            providers: [provider],
            providerAuthChoices: ["device-code", "oauth"].map((method) => ({
              provider,
              method,
              choiceId: `${provider}-${method}`,
              choiceLabel: `${provider} ${method}`,
              groupId: provider,
              groupLabel: provider,
              appGuidedAuth: method,
              credentialOnly: true,
              channelLogin: {},
            })),
          }),
        );
        cfg.commands = { text: true, ownerAllowFrom: ["111"] };
        cfg.plugins = {
          allow: ["reserved-recovery"],
          load: { paths: [pluginDir] },
          entries: { "reserved-recovery": { enabled: true } },
        };
      }
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          sessionId: "session-pinned-rate-limit",
          updatedAt: Date.now(),
          providerOverride: provider,
          modelOverride: "mock-1",
          modelOverrideSource: "user",
        },
      );
      runEmbeddedAttemptMock.mockImplementation(async (attemptParams) => {
        if (attemptParams.provider !== provider) {
          throw new Error(`unexpected fallback attempt: ${attemptParams.provider}`);
        }
        const assistant = buildEmbeddedRunnerAssistant({
          provider,
          model: attemptParams.modelId,
          stopReason: "error",
          errorMessage,
        });
        return makeEmbeddedRunnerAttempt({
          // A completed write prevents replay, so its error must use terminal payload delivery.
          toolMetas,
          assistantTexts: [],
          lastAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
        });
      });

      const ctx: MsgContext = {
        Body: "hello",
        From: "telegram:111",
        To: "telegram:111",
        ChatType: "direct",
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: sessionKey,
        CommandAuthorized: true,
      };
      const replyConfig = withFullRuntimeReplyConfig(cfg);
      setRuntimeConfigSnapshot(replyConfig, replyConfig);
      let result: Awaited<ReturnType<typeof getReplyFromConfig>>;
      const delivered: Array<{ payload: ReplyPayload; kind: ReplyDispatchKind }> = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload, { kind }) => {
          delivered.push({ payload, kind });
        },
      });
      try {
        result = await withReplyDispatcher({
          dispatcher,
          run: async () => {
            const replies = await getReplyFromConfig(ctx, undefined, replyConfig);
            for (const payload of Array.isArray(replies) ? replies : replies ? [replies] : []) {
              dispatcher.sendFinalReply(payload);
            }
            return replies;
          },
        });
      } finally {
        clearRuntimeConfigSnapshot();
      }
      const text = Array.isArray(result) ? result[0]?.text : result?.text;
      expect(countProviderAttempts("anthropic")).toBe(0);
      for (const [attempt] of runEmbeddedAttemptMock.mock.calls) {
        expect(
          authStore.profiles[expectDefined(attempt.authProfileId, "selected auth profile")],
        ).toMatchObject({
          provider,
          type: "api_key",
        });
      }
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.kind).toBe("final");
      expect(delivered[0]?.payload.isError).toBe(true);
      expect(delivered[0]?.payload.text?.trim().length).toBeGreaterThan(0);
      if (errorMessage === RATE_LIMIT_ERROR_MESSAGE) {
        expect(countProviderAttempts("openai")).toBeGreaterThan(2);
        expect(text).toContain("API rate limit reached");
        expect(delivered[0]?.payload.text).toContain("API rate limit reached");
      } else if (loginCommand) {
        expect(countProviderAttempts(provider)).toBe(1);
        if (reservedProviders.includes(provider)) {
          const action = delivered[0]?.payload.presentation?.blocks
            .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
            .find((button) => button.label === "Sign in")?.action;
          if (action?.type !== "command") {
            throw new Error("Expected the delivered Sign in command.");
          }
          const commandParams = buildCommandTestParams(
            action.command,
            replyConfig,
            { ...ctx, Body: action.command, SenderId: "111" },
            { workspaceDir },
          );
          const { handleCommands } = await import("../auto-reply/reply/commands-core.js");
          const recovery = await handleCommands({
            ...commandParams,
            agentId: "test",
            sessionKey,
            opts: { getProviderLoginConfig: () => replyConfig },
            resolveModelLevels: async () => ({
              resolvedThinkLevel: commandParams.resolvedThinkLevel,
              resolvedReasoningLevel: commandParams.resolvedReasoningLevel,
            }),
          });
          const menu = recovery.reply;
          expect(menu?.text).toContain("Choose a provider to sign in:");
          expect(menu?.presentation?.blocks).toContainEqual({
            type: "buttons",
            buttons: expect.arrayContaining([
              {
                label: provider,
                action: { type: "command", command: `/login oauth/reserved-recovery/${provider}` },
              },
            ]),
          });
          expect(countProviderAttempts(provider)).toBe(1);
        }
        expect(delivered[0]?.payload.text).toContain(loginCommand);
        expect(delivered[0]?.payload.presentation).toEqual({
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Sign in",
                  action: { type: "command", command: loginCommand },
                },
              ],
            },
          ],
        });
      } else {
        expect(countProviderAttempts(provider)).toBe(1);
        expect(delivered[0]?.payload.text).toContain("Authentication failed");
        expect(delivered[0]?.payload.text).not.toContain("/login");
        expect(delivered[0]?.payload.presentation).toBeUndefined();
      }
    });
  });
});
