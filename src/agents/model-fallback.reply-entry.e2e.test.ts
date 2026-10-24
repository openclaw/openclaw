// Proves the pinned fallback decision survives the complete reply-entry path.
import path from "node:path";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { withReplyDispatcher } from "../auto-reply/dispatch-dispatcher.js";
import type { ReplyDispatchKind } from "../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
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

it.each([
  ["openai", RATE_LIMIT_ERROR_MESSAGE, undefined],
  ["openai", "401 invalid API key", undefined],
  ["openai", "OAuth token refresh failed for openai: refresh_token_invalidated", "/login openai"],
  ["refresh", "OAuth token refresh failed for refresh: refresh_token_invalidated", "/login"],
] as const)("delivers pinned %s failure: %s", async (provider, errorMessage, loginCommand) => {
  // The disabled fallback ladder must reach the embedded runner instead of escalating.
  // #171760 made exhausted no-progress recovery explicit, including for pinned models.
  await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
    if (provider === "openai") {
      await writeFallbackMultiProfileAuthStore(agentDir);
    } else {
      await writeFallbackAuthStore(agentDir, undefined, { primaryProvider: provider });
    }
    const sessionKey = "agent:test:telegram:111";
    const storePath = path.join(path.dirname(agentDir), "sessions.json");
    const cfg = {
      ...makeModelFallbackConfig(provider),
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: { primary: `${provider}/mock-1`, fallbacks: ["groq/mock-2"] },
        },
        entries: { test: { agentDir, workspace: workspaceDir } },
      },
      session: { store: storePath },
    };
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
        toolMetas: errorMessage === RATE_LIMIT_ERROR_MESSAGE ? [] : completedWriteToolMetas,
        lastAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
      });
    });

    const replyConfig = withFullRuntimeReplyConfig(cfg);
    setRuntimeConfigSnapshot(replyConfig, replyConfig);
    const delivered: Array<{ payload: ReplyPayload; kind: ReplyDispatchKind }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, { kind }) => {
        delivered.push({ payload, kind });
      },
    });
    const result = await withReplyDispatcher({
      dispatcher,
      run: async () => {
        const replies = await getReplyFromConfig(
          {
            Body: "hello",
            From: "telegram:111",
            To: "telegram:111",
            ChatType: "direct",
            Provider: "telegram",
            Surface: "telegram",
            SessionKey: sessionKey,
            CommandAuthorized: true,
          },
          undefined,
          replyConfig,
        );
        for (const payload of Array.isArray(replies) ? replies : replies ? [replies] : []) {
          dispatcher.sendFinalReply(payload);
        }
        return replies;
      },
    });
    const text = Array.isArray(result) ? result[0]?.text : result?.text;
    expect([
      ...new Set(runEmbeddedAttemptMock.mock.calls.map(([attempt]) => attempt.provider)),
    ]).toEqual([provider]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ kind: "final", payload: { isError: true } });
    const payload = delivered[0]?.payload;
    if (errorMessage === RATE_LIMIT_ERROR_MESSAGE) {
      expect(runEmbeddedAttemptMock.mock.calls.length).toBeGreaterThan(2);
      for (const surfaced of [text, payload?.text]) {
        expect(surfaced).toContain("Rate-limit recovery stopped after");
        expect(surfaced).not.toContain("The AI service is temporarily rate-limited");
      }
    } else {
      expect(runEmbeddedAttemptMock).toHaveBeenCalledOnce();
      if (loginCommand) {
        expect(payload?.text).toContain(loginCommand);
        expect(payload?.presentation).toEqual({
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Sign in", action: { type: "command", command: loginCommand } }],
            },
          ],
        });
      } else {
        expect(payload?.text).toBe(AUTH_INVALID_TOKEN_USER_TEXT);
        expect(payload?.presentation).toBeUndefined();
      }
    }
  });
});
