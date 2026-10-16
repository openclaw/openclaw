// Proves the pinned fallback decision survives the complete reply-entry path.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { withReplyDispatcher } from "../auto-reply/dispatch-dispatcher.js";
import { buildCommandTestParams } from "../auto-reply/reply/commands.test-harness.js";
import type { ReplyDispatchKind } from "../auto-reply/reply/reply-dispatcher.types.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import { AUTH_INVALID_TOKEN_USER_TEXT } from "./failover/user-copy.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import { createFallbackE2eMocks } from "./model-fallback.e2e.test-support.js";
import {
  makeModelFallbackConfig,
  withModelFallbackWorkspace,
  writeFallbackAuthStore,
  writeFallbackMultiProfileAuthStore,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

const runEmbeddedAttemptMock =
  vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
const fallbackMocks = createFallbackE2eMocks((params) => runEmbeddedAttemptMock(params), true);
vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
}));

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
  fallbackMocks.install();
  ({ getReplyFromConfig } = await import("../auto-reply/reply/get-reply.js"));
  ({ withFullRuntimeReplyConfig } = await import("../auto-reply/reply/get-reply-fast-path.js"));
  ({ createReplyDispatcher } = await import("../auto-reply/reply/reply-dispatcher.js"));
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
  resetFallbackSkipCacheForTest();
  runEmbeddedAttemptMock.mockReset();
  fallbackMocks.clear();
});

function countProviderAttempts(provider: string): number {
  return runEmbeddedAttemptMock.mock.calls.filter(([params]) => params.provider === provider)
    .length;
}
function commandButton(label: string, command: string) {
  return { label, action: { type: "command" as const, command } };
}

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
  ...["openai", "xai", "minimax-portal", ...reservedProviders].map((provider) => ({
    title: `delivers returned ${provider} OAuth recovery after a write`,
    provider,
    errorMessage: `OAuth token refresh failed for ${provider}: refresh_token_invalidated`,
    toolMetas: completedWriteToolMetas,
    loginCommand: reservedProviders.includes(provider) ? "/login" : `/login ${provider}`,
  })),
])("getReplyFromConfig: $title", async ({ provider, errorMessage, toolMetas, loginCommand }) => {
  // The disabled fallback ladder must reach the embedded runner instead of escalating.
  // #171760 made exhausted no-progress recovery explicit, including for pinned models.
  await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
    if (provider === "openai") {
      await writeFallbackMultiProfileAuthStore(agentDir);
    } else {
      await writeFallbackAuthStore(agentDir, undefined, { primaryProvider: provider });
    }
    const authStore = ensureAuthProfileStore(agentDir, { syncExternalCli: false });
    const cfg = makeModelFallbackConfig(provider);
    const agents = expectDefined(cfg.agents, "fixture agents");
    const defaults = expectDefined(agents.defaults, "fixture defaults");
    const providers = expectDefined(cfg.models?.providers, "fixture providers");
    const groqProvider = expectDefined(providers.groq, "fixture fallback provider");
    const sessionKey = "agent:test:telegram:111";
    const storePath = path.join(path.dirname(agentDir), "sessions.json");
    defaults.workspace = workspaceDir;
    defaults.model = { primary: `${provider}/mock-1`, fallbacks: ["anthropic/mock-2"] };
    agents.entries = { test: { agentDir, workspace: workspaceDir } };
    providers.anthropic = { ...groqProvider, baseUrl: "https://example.com/anthropic" };
    cfg.session = { store: storePath };
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
      ).toMatchObject({ provider, type: "api_key" });
    }
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ kind: "final", payload: { isError: true } });
    const payload = delivered[0]?.payload;
    expect(payload?.text?.trim().length).toBeGreaterThan(0);
    if (errorMessage === RATE_LIMIT_ERROR_MESSAGE) {
      expect(countProviderAttempts("openai")).toBeGreaterThan(2);
      for (const surfaced of [text, payload?.text]) {
        expect(surfaced).toContain("Rate-limit recovery stopped after");
        expect(surfaced).not.toContain("The AI service is temporarily rate-limited");
      }
    } else if (loginCommand) {
      expect(countProviderAttempts(provider)).toBe(1);
      if (reservedProviders.includes(provider)) {
        const action = payload?.presentation?.blocks
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
            commandButton(provider, `/login oauth/reserved-recovery/${provider}`),
          ]),
        });
        expect(countProviderAttempts(provider)).toBe(1);
      }
      expect(payload?.text).toContain(loginCommand);
      expect(payload?.presentation).toEqual({
        blocks: [{ type: "buttons", buttons: [commandButton("Sign in", loginCommand)] }],
      });
    } else {
      expect(countProviderAttempts(provider)).toBe(1);
      expect(payload?.text).toBe(AUTH_INVALID_TOKEN_USER_TEXT);
      expect(payload?.text).not.toContain("/login");
      expect(payload?.presentation).toBeUndefined();
    }
  });
});
