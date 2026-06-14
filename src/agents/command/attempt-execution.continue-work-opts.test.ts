/**
 * Regression-pin trap-test for #746 Layer 2 cure (PR #892 complement).
 *
 * Asserts that `runAgentAttempt` (the spawn-init / turn-1 path that subagent
 * gateway invocations land on via callSubagentGateway → agentCommandInternal →
 * runAgentAttempt → runEmbeddedAgent) forwards a `continueWorkOpts` closure to
 * `runEmbeddedAgent` whenever `cfg.agents.defaults.continuation.enabled === true`.
 *
 * Without this wiring, openclaw-tools.ts:592 evaluates
 * `options?.continueWorkOpts` as undefined on turn-1, the `continue_work` tool
 * never registers in the subagent's spawn-init tool-list, and subagent sessions
 * cannot self-elect another turn even though PR #892 cured the same gap on the
 * followup-runner (turn-2+) path. Empirical observation:
 * `CONTINUE_WORK STILL NOT AVAILABLE` post-PR-#892-merge.
 *
 * Cure-mechanism-distinction: same observable `turn 2/200` event can be
 * produced by either chain-hop (continue_delegate) or in-session continue_work.
 * This test pins the tool-list-introspection invariant (continueWorkOpts
 * present on turn-1) so the cure path can be verified independently of the
 * delivery mechanism.
 *
 * Trap-test-first methodology (RED on the pre-cure shape, GREEN after).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
  type SessionEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { runAgentAttempt } from "./attempt-execution.js";

const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const runCliAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string) =>
    provider.trim().toLowerCase() === "claude-cli" || provider.trim().toLowerCase() === "codex-cli",
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../model-runtime-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../model-runtime-aliases.js")>(
    "../model-runtime-aliases.js",
  );
  return {
    ...actual,
    resolveCliRuntimeExecutionProvider: ({ provider }: { provider?: string }) => provider,
  };
});

vi.mock("../embedded-agent.js", () => ({
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

function makeEmbeddedResult(): EmbeddedAgentRunResult {
  return {
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 1,
      finalAssistantVisibleText: "ok",
      agentMeta: {
        sessionId: "session-embedded",
        provider: "anthropic",
        model: "claude-sonnet-4.7",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          total: 2,
        },
      },
    },
  };
}

function makeContinuationEnabledConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          maxChainLength: 200,
          defaultDelayMs: 15000,
          minDelayMs: 5000,
          maxDelayMs: 86400000,
          costCapTokens: 50000000,
          maxDelegatesPerTurn: 500,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function makeContinuationDisabledConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {},
    },
  } as unknown as OpenClawConfig;
}

// Continuation enabled but pinned at the chain cap (maxChainLength:1): a session
// already at currentChainCount:1 trips checkContinuationBudget on the FIRST
// election, so scheduleContinuationWorkBatch returns scheduledCount:0.
function makeAtCapContinuationConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          maxChainLength: 1,
          defaultDelayMs: 15000,
          minDelayMs: 5000,
          maxDelayMs: 86400000,
          costCapTokens: 50000000,
          maxDelegatesPerTurn: 500,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("runAgentAttempt #746 spawn-init continueWorkOpts plumbing (Layer 2 cure)", () => {
  let tmpDir: string;
  let sessionEntry: SessionEntry;
  let sessionStore: Record<string, SessionEntry>;
  let storePath: string;
  const sessionKey = "agent:main:subagent:746-trap";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-746-trap-"));
    storePath = path.join(tmpDir, "sessions.json");
    runEmbeddedAgentMock.mockReset();
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockResolvedValue(makeEmbeddedResult());
    sessionEntry = {
      sessionId: "session-embedded",
      updatedAt: Date.now(),
    } as SessionEntry;
    sessionStore = { [sessionKey]: sessionEntry };
    await saveSessionStore(storePath, sessionStore, { skipMaintenance: true });
    clearSessionStoreCacheForTest();
  });

  afterEach(async () => {
    const { resetContinuationWorkDispatchForTests } =
      await import("../../auto-reply/continuation/work-dispatch.js");
    const { resetTaskFlowRegistryForTests } = await import("../../tasks/task-flow-registry.js");
    resetContinuationWorkDispatchForTests();
    resetTaskFlowRegistryForTests({ persist: false });
    resetSystemEventsForTest();
    clearRuntimeConfigSnapshot();
    clearSessionStoreCacheForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runEmbeddedAttempt(cfg: OpenClawConfig) {
    return await runAgentAttempt({
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-sonnet-4.7",
      cfg,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      lifecycleGeneration: "test-generation",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "trap-test prompt",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-746-trap",
      opts: {} as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: tmpDir,
      onAgentEvent: vi.fn(),
      authProfileProvider: "anthropic",
      sessionStore,
      storePath,
      sessionHasHistory: false,
    });
  }

  it("forwards continueWorkOpts to runEmbeddedAgent when continuation.enabled=true (spawn-init / turn-1)", async () => {
    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | { continueWorkOpts?: { requestContinuation?: unknown } }
      | undefined;
    expect(callArgs).toBeDefined();
    // RED: pre-cure this is undefined → continue_work never registers in
    //      the subagent's turn-1 tool-list.
    expect(callArgs?.continueWorkOpts).toBeDefined();
    expect(typeof callArgs?.continueWorkOpts?.requestContinuation).toBe("function");
  });

  it("does NOT forward continueWorkOpts when continuation is disabled", async () => {
    await runEmbeddedAttempt(makeContinuationDisabledConfig());

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | { continueWorkOpts?: unknown }
      | undefined;
    expect(callArgs?.continueWorkOpts).toBeUndefined();
  });

  // Extended coverage: exercise the closure end-to-end
  // so that a future regression which forwards a *stub* closure (instead of
  // the runner-supplied accumulator) is still caught. Pinning the presence of
  // requestContinuation alone is necessary but not sufficient — the closure
  // must actually capture continue_work tool-call payloads for the post-turn
  // heartbeat scheduler to fire.

  it("persists spawn-init continue_work chain state to the session store", async () => {
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "persist budgets", delaySeconds: 30 });
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    clearSessionStoreCacheForTest();
    const persisted = loadSessionStore(storePath, { skipCache: true });
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
    expect(persisted[sessionKey]?.continuationChainCount).toBe(1);
    expect(persisted[sessionKey]?.continuationChainTokens).toBe(2);
  });

  // P2-2 never-silent symmetry: the spawn-init lane must surface a multi-election
  // cap-drop even when NOTHING scheduled (scheduledCount:0, cappedCount>0). The
  // cap-notice emit lives ABOVE the zero-scheduled early return so this lane
  // matches the main-reply (agent-runner) and followup (followup-runner) lanes,
  // which both emit the cap-notice regardless of scheduledCount.
  it("emits the cap-notice on spawn-init when a multi continue_work batch schedules nothing at the cap (P2-2)", async () => {
    // Seed the session already at the chain cap so the FIRST election is
    // rejected: scheduleContinuationWorkBatch returns scheduledCount:0,
    // cappedCount:2 — the exact case the spawn-init lane used to drop silently.
    sessionEntry.continuationChainCount = 1;
    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore, { skipMaintenance: true });
    clearSessionStoreCacheForTest();
    // The continuation budget reads the live runtime-config snapshot (see
    // resolveLiveContinuationRuntimeConfig); set it to the at-cap config so the
    // chain-cap fires deterministically regardless of ambient snapshot state.
    setRuntimeConfigSnapshot(makeAtCapContinuationConfig());

    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      // Two elections this turn — multi-election is required for the cap-notice.
      opts?.requestContinuation({ reason: "first election", delaySeconds: 30 });
      opts?.requestContinuation({ reason: "second election", delaySeconds: 30 });
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeAtCapContinuationConfig());

    const events = peekSystemEvents(sessionKey);
    expect(
      events.some((text) => text.includes("2 of 2 continue_work elections were not scheduled")),
    ).toBe(true);

    // Nothing scheduled, so the seeded chain count must NOT advance.
    expect(sessionStore[sessionKey]?.continuationChainCount).toBe(1);
  });

  // Single-election guard: keep single-work behavior intact. A lone capped
  // election stays silent on the spawn-init lane, matching the `requests > 1`
  // guard shared by the main-reply and followup lanes.
  it("stays silent for a single capped continue_work election on spawn-init (P2-2 guard)", async () => {
    sessionEntry.continuationChainCount = 1;
    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore, { skipMaintenance: true });
    clearSessionStoreCacheForTest();
    setRuntimeConfigSnapshot(makeAtCapContinuationConfig());

    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "lone election", delaySeconds: 30 });
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeAtCapContinuationConfig());

    const events = peekSystemEvents(sessionKey);
    expect(events.some((text) => text.includes("continue_work elections were not scheduled"))).toBe(
      false,
    );
  });

  it("does not strip bracket continue_delegate markers while peeking for spawn-init continue_work", async () => {
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done\n[[CONTINUE_DELEGATE: next hop]]" }],
      meta: {
        durationMs: 1,
        finalAssistantVisibleText: "done",
        agentMeta: {
          sessionId: "session-embedded",
          provider: "anthropic",
          model: "claude-sonnet-4.7",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        },
      },
    } satisfies EmbeddedAgentRunResult);

    const result = await runEmbeddedAttempt(makeContinuationEnabledConfig());

    expect(result.payloads?.[0]?.text).toContain("[[CONTINUE_DELEGATE: next hop]]");
  });

  it("lets bracket continue_work use the configured default delay when a tool delay also exists", async () => {
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      opts?.requestContinuation({ reason: "tool delay should not win", delaySeconds: 30 });
      return {
        payloads: [{ text: "done\nCONTINUE_WORK" }],
        meta: {
          durationMs: 1,
          finalAssistantVisibleText: "done",
          agentMeta: {
            sessionId: "session-embedded",
            provider: "anthropic",
            model: "claude-sonnet-4.7",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
          },
        },
      } satisfies EmbeddedAgentRunResult;
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const { listTaskFlowsForOwnerKey } = await import("../../tasks/task-flow-registry.js");
    const [flow] = listTaskFlowsForOwnerKey(sessionKey);
    expect(flow?.stateJson).toMatchObject({
      kind: "continuation_work",
      delayMs: 15000,
    });
  });

  it("captured continue_work request is invocable end-to-end on spawn-init (turn-1 cure-mechanism pin)", async () => {
    // Simulate a runEmbeddedAgent run that fires continue_work mid-turn by
    // invoking the supplied closure with a representative request payload.
    runEmbeddedAgentMock.mockImplementationOnce(async (callArgs: unknown) => {
      const opts = (
        callArgs as {
          continueWorkOpts?: {
            requestContinuation: (req: { reason: string; delaySeconds: number }) => void;
          };
        }
      ).continueWorkOpts;
      if (!opts) {
        throw new Error(
          "continueWorkOpts missing — Layer 2 cure regressed; subagent turn-1 cannot continue_work",
        );
      }
      opts.requestContinuation({ reason: "trap-test", delaySeconds: 30 });
      return makeEmbeddedResult();
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    // No throw means the closure was both present and invocable. The
    // post-turn scheduler runs asynchronously via dynamic imports and arms
    // a timer; we don't assert on the timer itself here (covered by the
    // existing continuation-state test suite), only on the wiring invariant.
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });
});

// Cross-layer drift-catch:
//   - Layer 1 (turn-2+ followup-runner): pinned by
//     src/auto-reply/reply/followup-runner.test.ts
//     "createFollowupRunner continueWorkOpts threading (#746)".
//   - Layer 2 (turn-1 spawn-init runAgentAttempt): pinned by this file.
// Together these prevent a regression that fixes one Layer in isolation from
// silently reopening the gap on the other Layer (the same
// false-empirical-proof class).
describe("#746 cross-layer drift-catch sentinel", () => {
  it("documents both Layer 1 + Layer 2 cure sites for #746 (sentinel only)", () => {
    // This sentinel exists so a future maintainer searching for "#746" in
    // test output sees both cure sites referenced from one place. Intentional
    // no-op assertion; the real coverage lives in the two file-specific tests.
    expect(true).toBe(true);
  });
});
