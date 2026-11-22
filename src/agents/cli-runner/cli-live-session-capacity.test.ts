import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAgentExecutionError } from "../../auto-reply/reply/agent-runner-error-handler.js";
import type { AgentTurnParams } from "../../auto-reply/reply/agent-runner-execution.types.js";
import type { CliBackendLiveSessionHandle } from "../../plugins/cli-backend.types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import {
  createCliLiveSessionCapability,
  ensureCliLiveSessionMemory,
} from "./cli-live-session-registry.js";
import { settlePreparedCliRun } from "./cli-run-settlement.js";
import { createCliExitFailoverError } from "./exit-error.js";

const authProfiles = vi.hoisted(() => ({
  markAuthProfileFailure: vi.fn<typeof import("../auth-profiles.js").markAuthProfileFailure>(
    async () => {},
  ),
  markAuthProfileSuccess: vi.fn(async () => {}),
}));
vi.mock("../auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-profiles.js")>()),
  ...authProfiles,
}));
const hostMemory = vi.hoisted(() => ({ freeBytes: vi.fn(() => 128 * 1024 ** 2) }));
vi.mock("../../infra/host-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/host-memory.js")>()),
  readHostFreeMemoryBytes: hostMemory.freeBytes,
}));

const registered: Array<() => void> = [];
afterEach(() => {
  for (const remove of registered.splice(0)) {
    remove();
  }
  vi.clearAllMocks();
});

/** Registers one more busy warm process for a new conversation; returns the refusal, if any. */
function registerBusyLiveSession(sessionId: string): unknown {
  const context = buildPreparedCliRunContext({ provider: "claude-cli", sessionId });
  const capability = createCliLiveSessionCapability({
    context,
    argv: ["claude", "-p"],
    env: {},
    beginCapture: () => {},
    abortSignal: new AbortController().signal,
  });
  const handle: CliBackendLiveSessionHandle = {
    generation: sessionId,
    fingerprint: capability.fingerprint,
    isIdle: () => false,
    close: () => capability.remove(handle),
    waitForExit: async () => {},
  };
  try {
    capability.register(handle);
  } catch (error) {
    return error;
  }
  registered.push(() => capability.remove(handle));
  return undefined;
}

const LIVE_SESSION_LIMIT_COPY =
  "⚠️ This host is already running as many sessions as it allows, so it could not start another one. Try again after active conversations finish.";
const HOST_MEMORY_COPY =
  "⚠️ This host is low on memory, so it could not start another session. Try again after active conversations finish.";

async function settleWithSavedLogin(error: unknown): Promise<string[]> {
  if (!(error instanceof Error)) {
    throw new TypeError("Expected a CLI failure", { cause: error });
  }
  const context = buildPreparedCliRunContext({ provider: "claude-cli", sessionId: "settle" });
  context.effectiveAuthProfileId = "claude-cli:default";
  context.authProfileStore = {
    version: 1,
    profiles: { "claude-cli:default": { type: "oauth", provider: "claude-cli" } },
  } as unknown as AuthProfileStore;
  await expect(settlePreparedCliRun({ context, run: () => Promise.reject(error) })).rejects.toBe(
    error,
  );
  return authProfiles.markAuthProfileFailure.mock.calls.map(([params]) => params.reason);
}

/** The reply runner's failure owner: the chat message and the card's failure notice. */
async function presentFailure(error: unknown, controlUi: boolean) {
  let notice: unknown;
  const result = await handleAgentExecutionError({
    turn: {
      sessionKey: "agent:main:main",
      sessionCtx: { ChatType: "direct" },
      followupRun: {
        run: {
          sessionId: "session",
          internalEventExecution: {
            onTerminalEvent: (event: { data: Record<string, unknown> }) => {
              notice = event.data.errorNotice;
            },
          },
        },
      },
    } as unknown as AgentTurnParams,
    error,
    runtimeConfig: {},
    runId: "run",
    state: {
      postCompactionModelAttempted: false,
      lifecycleGeneration: "1",
      turnStartedAtMs: Date.now(),
    } as never,
    liveModelSwitchRetries: 0,
    shouldSurfaceToControlUi: controlUi,
    timing: { logIfSlow: () => {} } as never,
    resolveVisibleReplyDelivery: async () => false,
    modelPatch: { fail: async () => {} },
  });
  return { message: result.kind === "final" ? result.payload.text : undefined, notice };
}

describe("a local CLI live-session refusal versus a provider rate limit", () => {
  it("keeps the saved login usable and explains the host, not the provider", async () => {
    const refusal = await ensureCliLiveSessionMemory(
      buildPreparedCliRunContext({ provider: "claude-cli", sessionId: "starved" }),
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "overloaded", status: undefined });
    expect(await settleWithSavedLogin(refusal)).toEqual([]);
    for (const controlUi of [true, false]) {
      expect(await presentFailure(refusal, controlUi)).toEqual({
        message: HOST_MEMORY_COPY,
        notice: HOST_MEMORY_COPY,
      });
    }
  });

  it("explains the host's session limit instead of blaming the provider", async () => {
    for (let index = 0; index < 16; index += 1) {
      expect(registerBusyLiveSession(`busy-${index}`)).toBeUndefined();
    }
    const refusal = registerBusyLiveSession("over-limit");

    expect(refusal).toMatchObject({ reason: "overloaded", status: undefined });
    expect(await settleWithSavedLogin(refusal)).toEqual([]);
    for (const controlUi of [true, false]) {
      expect(await presentFailure(refusal, controlUi)).toEqual({
        message: LIVE_SESSION_LIMIT_COPY,
        notice: LIVE_SESSION_LIMIT_COPY,
      });
    }
  });

  it("keeps a provider rate limit attributed to the provider and its saved login", async () => {
    const limit = createCliExitFailoverError({
      context: { provider: "claude-cli", model: "sonnet" },
      candidates: [
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50 requests per minute."}}',
      ],
      retryEmptyFailure: false,
    });

    expect(limit).toMatchObject({ reason: "rate_limit", status: 429 });
    expect(await settleWithSavedLogin(limit)).toEqual(["rate_limit"]);
    for (const controlUi of [true, false]) {
      const { message, notice } = await presentFailure(limit, controlUi);
      expect(message).toMatch(/AI service|rate limit/i);
      expect(message).not.toMatch(/memory|host/i);
      expect(notice).toBe(message);
    }
  });
});
