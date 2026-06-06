/**
 * Regression-pin trap-test for #917 (sister-of-#746 / half-symmetric-cure-class).
 *
 * Asserts that `runAgentAttempt` (the spawn-init / turn-1 path that subagent
 * gateway invocations land on) constructs and forwards a
 * `requestCompactionOpts` closure to `runEmbeddedAgent` whenever
 * `cfg.agents.defaults.continuation.enabled === true`.
 *
 * Without this wiring, openclaw-tools.ts:609 evaluates
 * `options?.requestCompactionOpts` as undefined on turn-1, the
 * `request_compaction` tool never registers in the subagent's spawn-init
 * tool-list, and a subagent that has been given continue_work capability
 * (via PR #898's cure for #746 Layer 2) can schedule its own next turn but
 * cannot reclaim context mid-flight when pressure rises.
 *
 * Half-symmetric-cure-class: PR #898 cured `continueWorkOpts` plumbing at
 * the same `runAgentAttempt` spawn-init code path, but the sibling
 * closure for `request_compaction` was not constructed. The sibling
 * surface lived all along inside `runEmbeddedAttempt` via
 * `params.requestCompactionOpts` (already-plumbed through
 * `src/agents/embedded-agent-runner/run.ts:1569`); the gap was strictly
 * the *construction* of the closure at `runAgentAttempt` to feed into
 * `runEmbeddedAgent`.
 *
 * Empirical substrate:
 *  - rune subagent `agent:main:subagent:53cd57ac` returned TOOL_NOT_IN_LIST
 *    on `request_compaction` at discord:1511936885
 *  - emeric R-RC-1 HONEST-LIMIT at openclaw-bootstrap commit 9684479
 *  - cael main-session contrast `1511935121` (REGISTERED + REJECT-at-41%)
 *  - cael code-byte-walk `1511929995`: ZERO `requestCompactionOpts`
 *    matches at attempt-execution.ts spawn-init code path pre-cure
 *
 * Trap-test-first per figs `1511931252` + cohort cosign (rune + cael +
 * emeric) + frond `1511932561` (karmaterminal/openclaw#917 issue) +
 * R-REGRESSION-TRAP-TESTS-family discipline canonized at
 * openclaw-bootstrap PR #1120 (PROOF-CORPUS-METHOD.md per-prince-row
 * assignments redistribute).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { runAgentAttempt } from "./attempt-execution.js";

const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const runCliAgentMock = vi.hoisted(() => vi.fn());
const releaseQueuedCompactionTolerantMock = vi.hoisted(() => vi.fn());
const compactEmbeddedAgentSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

// Spy on the post-compaction release while keeping the rest of the module real
// (computeRequestCompactionContextUsage is used by the closure under test).
vi.mock("../../auto-reply/reply/agent-runner-execution.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../auto-reply/reply/agent-runner-execution.js")
  >("../../auto-reply/reply/agent-runner-execution.js");
  return {
    ...actual,
    releaseQueuedCompactionTolerant: releaseQueuedCompactionTolerantMock,
  };
});

// Intercept the dynamic import inside triggerCompaction so the closure can be
// driven without performing a real compaction.
vi.mock("../embedded-agent-runner/compact.queued.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
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

describe("runAgentAttempt #917 spawn-init requestCompactionOpts plumbing (sister-of-#746)", () => {
  let tmpDir: string;
  let sessionEntry: SessionEntry;
  let sessionStore: Record<string, SessionEntry>;
  let storePath: string;
  const sessionKey = "agent:main:subagent:917-trap";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-917-trap-"));
    storePath = path.join(tmpDir, "sessions.json");
    runEmbeddedAgentMock.mockReset();
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockResolvedValue(makeEmbeddedResult());
    sessionEntry = {
      sessionId: "session-embedded",
      updatedAt: Date.now(),
    } as SessionEntry;
    sessionStore = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runEmbeddedAttempt(cfg: OpenClawConfig) {
    await runAgentAttempt({
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-sonnet-4.7",
      cfg,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionAgentId: "main",
      sessionFile: path.join(tmpDir, "session.jsonl"),
      workspaceDir: tmpDir,
      body: "trap-test prompt",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-917-trap",
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

  it("forwards requestCompactionOpts to runEmbeddedAgent when continuation.enabled=true (spawn-init / turn-1)", async () => {
    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | {
          requestCompactionOpts?: {
            sessionId?: string;
            getContextUsage?: unknown;
            triggerCompaction?: unknown;
          };
        }
      | undefined;
    expect(callArgs).toBeDefined();
    // RED: pre-cure this is undefined → request_compaction never registers
    //      in the subagent's turn-1 tool-list. Sister-of-#746 / #898's
    //      continueWorkOpts-only construction at this same code path.
    expect(callArgs?.requestCompactionOpts).toBeDefined();
    expect(typeof callArgs?.requestCompactionOpts?.getContextUsage).toBe("function");
    expect(typeof callArgs?.requestCompactionOpts?.triggerCompaction).toBe("function");
    expect(callArgs?.requestCompactionOpts?.sessionId).toBe(sessionEntry.sessionId);
  });

  it("does NOT forward requestCompactionOpts when continuation is disabled", async () => {
    await runEmbeddedAttempt(makeContinuationDisabledConfig());

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | { requestCompactionOpts?: unknown }
      | undefined;
    expect(callArgs?.requestCompactionOpts).toBeUndefined();
  });

  // Cure-mechanism pin per cael 1511929995 + rune empirical: the
  // tool-list-registration gap manifests at openclaw-tools.ts:609 — if the
  // closure carries getContextUsage as the wrong shape (e.g. async, or
  // missing the null-return contract), the request_compaction tool factory
  // will still register but fire incorrect REJECT-shape on call. Pin the
  // shape so a future regression that supplies a stub-shaped closure is
  // still caught here, not only at the integration-empirical layer.
  it("requestCompactionOpts.getContextUsage returns sync number-or-null (cure-mechanism shape)", async () => {
    await runEmbeddedAttempt(makeContinuationEnabledConfig());

    const callArgs = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | { requestCompactionOpts?: { getContextUsage: () => number | null } }
      | undefined;
    expect(callArgs?.requestCompactionOpts).toBeDefined();

    // Should be invocable without throwing and return number | null
    // (synchronous, matching computeRequestCompactionContextUsage contract
    // at agent-runner-execution.ts:252-287).
    const result = callArgs?.requestCompactionOpts?.getContextUsage();
    expect(result === null || typeof result === "number").toBe(true);
  });

  // Half-cure-gap codex P2 (#918's own cure-file, attempt-execution.ts:730):
  // a successful turn-1 / spawn-init volitional compaction must run the
  // `releaseQueuedCompactionTolerant` step used by the followup path so staged
  // `continue_delegate(mode="post-compaction")` work is dispatched. Pre-cure
  // the spawn-init triggerCompaction returned immediately and the delegates
  // stayed queued.
  it("triggerCompaction releases queued post-compaction delegates after a successful compaction", async () => {
    releaseQueuedCompactionTolerantMock.mockReset();
    compactEmbeddedAgentSessionMock.mockReset();
    const compactionResult = { ok: true, compacted: true, reason: undefined };
    compactEmbeddedAgentSessionMock.mockResolvedValue(compactionResult);

    await runEmbeddedAttempt(makeContinuationEnabledConfig());
    const triggerCompaction = (
      runEmbeddedAgentMock.mock.calls[0]?.[0] as {
        requestCompactionOpts?: {
          triggerCompaction: (req: { trigger: string; runId?: string }) => Promise<unknown>;
        };
      }
    )?.requestCompactionOpts?.triggerCompaction;
    expect(typeof triggerCompaction).toBe("function");

    const result = await triggerCompaction!({ trigger: "volitional", runId: "run-917-trap" });
    expect(result).toEqual({ ok: true, compacted: true, reason: undefined });

    expect(releaseQueuedCompactionTolerantMock).toHaveBeenCalledTimes(1);
    const releaseArgs = releaseQueuedCompactionTolerantMock.mock.calls[0]?.[0] as {
      compactionResult?: unknown;
      sessionKey?: string;
      storePath?: string;
      followupRun?: { run?: { config?: unknown; sessionId?: string; workspaceDir?: string } };
    };
    expect(releaseArgs.compactionResult).toBe(compactionResult);
    expect(releaseArgs.sessionKey).toBe(sessionKey);
    expect(releaseArgs.storePath).toBe(storePath);
    // The synthesized FollowupRun carries the fields the dispatch path reads.
    expect(releaseArgs.followupRun?.run?.config).toBeDefined();
    expect(releaseArgs.followupRun?.run?.sessionId).toBe(sessionEntry.sessionId);
    expect(releaseArgs.followupRun?.run?.workspaceDir).toBe(tmpDir);
  });

  it("triggerCompaction does NOT release when compaction did not apply", async () => {
    releaseQueuedCompactionTolerantMock.mockReset();
    compactEmbeddedAgentSessionMock.mockReset();
    compactEmbeddedAgentSessionMock.mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below-threshold",
    });

    await runEmbeddedAttempt(makeContinuationEnabledConfig());
    const triggerCompaction = (
      runEmbeddedAgentMock.mock.calls[0]?.[0] as {
        requestCompactionOpts?: {
          triggerCompaction: (req: { trigger: string }) => Promise<unknown>;
        };
      }
    )?.requestCompactionOpts?.triggerCompaction;

    await triggerCompaction!({ trigger: "volitional" });
    expect(releaseQueuedCompactionTolerantMock).not.toHaveBeenCalled();
  });
});

// Cross-layer half-symmetric-cure-class sentinel:
//   - #746 Layer 1 (turn-2+ followup-runner): src/auto-reply/reply/followup-runner.test.ts
//   - #746 Layer 2 (turn-1 spawn-init runAgentAttempt continueWorkOpts):
//     attempt-execution.continue-work-opts.test.ts
//   - #917 (turn-1 spawn-init runAgentAttempt requestCompactionOpts): this file
// Together these prevent a regression that fixes one tool's plumbing in
// isolation from silently leaving the sibling tool's plumbing unwired at
// the same code path — the half-symmetric-cure-class instance that
// produced #917 in the first place.
describe("#917 half-symmetric-cure-class drift-catch sentinel", () => {
  it("documents both sibling cure sites for spawn-init continuation tools (sentinel only)", () => {
    // This sentinel exists so a future maintainer searching for #917 +
    // sister-of-#746 in test output sees both sibling cure sites
    // referenced from one place. Intentional no-op assertion; the real
    // coverage lives in the two file-specific tests
    // (attempt-execution.continue-work-opts.test.ts pins continueWorkOpts;
    // this file pins requestCompactionOpts).
    expect(true).toBe(true);
  });
});
