/** Tests bounded transcript-flush probing before reusing CLI bindings. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { CliOutput } from "../cli-output-contracts.js";
import {
  isCliBindingFlushed,
  restoreCliRunnerTestDeps,
  setCliRunnerTestDeps,
} from "../cli-runner.js";
import {
  clearCliSession,
  cliSessionClearAuthFromRun,
  CLI_SESSION_CLEAR_AUTH_UNKNOWN,
  getCliSessionBinding,
  resolveCliSessionReuse,
  setCliSessionBinding,
  setCliSessionId,
} from "../cli-session.js";
import { buildCliRunResult } from "./cli-run-settlement.js";
import type { CliReusableSession, PreparedCliRunContext } from "./types.js";

vi.mock("../embedded-agent-runner/run/payloads.js", () => ({
  buildEmbeddedRunPayloads: () => [],
}));
vi.mock("../embedded-agent-runner/run/tool-media-payloads.js", () => ({
  mergeAttemptToolMediaPayloads: ({ payloads }: { payloads: unknown }) => payloads,
}));

/**
 * Exercises settlement's clear request through the public `buildCliRunResult`
 * entrypoint by observing `clearCliSessionBinding` in the result's agentMeta.
 */
function buildSettlementResult(
  reusableCliSession: CliReusableSession,
  opts: { sessionBindingDisabled?: boolean; unflushed?: boolean } = {},
) {
  const { sessionBindingDisabled = false, unflushed = true } = opts;
  const context = {
    params: { provider: "test", sessionId: "s1", runId: "r1" },
    started: Date.now(),
    modelId: "m1",
    systemPromptReport: {},
    reusableCliSession,
    backendResolved: { id: "b1" },
    preparedBackend: {},
    authEpochVersion: 0,
  } as PreparedCliRunContext;
  return buildCliRunResult({
    context,
    output: {} as CliOutput,
    effectiveCliSessionId: unflushed ? "sid-unflushed" : undefined,
    bindingFlushOk: unflushed ? false : undefined,
    usedHistoryPrompt: false,
    userTurnHandled: false,
    sessionBindingDisabled,
    preparedContextAgentMeta: {},
  });
}

describe("settlement binding clears preserve the auth boundary", () => {
  it("requests the clear for every unflushed binding, auth-invalidated or not", () => {
    // Settlement carries no auth-boundary policy of its own: `clearCliSession`
    // owns it. Re-adding a local exception here is what created two divergent
    // copies of the rule in the first place.
    for (const reusableCliSession of [
      { mode: "none" },
      { mode: "reuse", sessionId: "sid-prev" },
      { mode: "invalidate", invalidatedReason: "missing-transcript" },
      { mode: "invalidate", invalidatedReason: "mcp" },
      { mode: "invalidate", invalidatedReason: "auth-profile" },
      { mode: "invalidate", invalidatedReason: "auth-epoch" },
    ] as const) {
      const result = buildSettlementResult(reusableCliSession);
      expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    }
  });

  it("clears disabled bindings and keeps flushed bindings", () => {
    const disabled = buildSettlementResult(
      { mode: "invalidate", invalidatedReason: "auth-profile" },
      { sessionBindingDisabled: true },
    );
    expect(disabled.meta.agentMeta?.clearCliSessionBinding).toBe(true);

    const flushed = buildSettlementResult(
      { mode: "reuse", sessionId: "sid-prev" },
      { unflushed: false },
    );
    expect(flushed.meta.agentMeta?.clearCliSessionBinding).toBeUndefined();
  });

  it("leaves an auth boundary that the next turn resolves as auth-profile, not missing-transcript", () => {
    // The end-to-end P1: settlement asks for the clear, the shared owner applies
    // it, and the next turn must still see the auth boundary. If the owner erased
    // the record the next turn would resolve `{mode:"none"}`, prepare would fall
    // back to `missing-transcript`, and raw reseed would cross the auth boundary.
    const result = buildSettlementResult({
      mode: "invalidate",
      invalidatedReason: "auth-profile",
    });
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);

    const entry = { sessionId: "s1" } as SessionEntry;
    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "sid-prev",
      authProfileId: "anthropic:old-profile",
      authEpoch: "epoch-old",
      authEpochVersion: 1,
    });
    clearCliSession(entry, "claude-cli", CLI_SESSION_CLEAR_AUTH_UNKNOWN);

    // The resumable handle and its legacy mirrors are gone.
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBeUndefined();
    expect(entry.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();

    // The auth identity it was written under survives.
    expect(
      resolveCliSessionReuse({
        binding: getCliSessionBinding(entry, "claude-cli"),
        authProfileId: "anthropic:new-profile",
        authEpoch: "epoch-new",
        authEpochVersion: 1,
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
  });

  it("keeps the surviving boundary scoped to a real auth change", () => {
    // The tombstone must not masquerade as an invalidation forever: once the
    // next turn carries the same auth identity, raw reseed no longer crosses a
    // boundary and the session must read as unbound again.
    const sameIdentity = { sessionId: "s1" } as SessionEntry;
    setCliSessionBinding(sameIdentity, "claude-cli", {
      sessionId: "sid-prev",
      authProfileId: "anthropic:same-profile",
      authEpoch: "epoch-same",
      authEpochVersion: 1,
    });
    clearCliSession(sameIdentity, "claude-cli", CLI_SESSION_CLEAR_AUTH_UNKNOWN);
    expect(
      resolveCliSessionReuse({
        binding: getCliSessionBinding(sameIdentity, "claude-cli"),
        authProfileId: "anthropic:same-profile",
        authEpoch: "epoch-same",
        authEpochVersion: 1,
      }),
    ).toEqual({ mode: "none" });

    // A binding with no auth identity of its own takes the boundary from the
    // identity the clearing turn resolved, so the record still survives.
    const noIdentity = { sessionId: "s2" } as SessionEntry;
    setCliSessionBinding(noIdentity, "claude-cli", { sessionId: "sid-prev" });
    clearCliSession(
      noIdentity,
      "claude-cli",
      cliSessionClearAuthFromRun({
        authProfileId: "anthropic:current",
        authEpoch: "epoch-current",
        authEpochVersion: 1,
      }),
    );
    expect(getCliSessionBinding(noIdentity, "claude-cli")).toEqual({
      authProfileId: "anthropic:current",
      authEpoch: "epoch-current",
      authEpochVersion: 1,
    });
  });
});

describe("clears record the current auth identity when the binding recorded none", () => {
  const currentIdentity = {
    authProfileId: "anthropic:current",
    authEpoch: "epoch-current",
    authEpochVersion: 1,
  } as const;

  /** The reuse verdict the turn after a clear would see. */
  function reuseAfterClear(
    entry: SessionEntry,
    current: { authProfileId?: string; authEpoch?: string; authEpochVersion: number },
  ) {
    return resolveCliSessionReuse({
      binding: getCliSessionBinding(entry, "claude-cli"),
      ...current,
    });
  }

  it("keeps a bare binding's clear reseed-eligible under the same identity", () => {
    // The P1 this closes: the bare-id fallback writes a binding with no auth
    // identity, so a clear used to erase it outright. The next turn read
    // `{mode:"none"}`, prepare defaulted to `missing-transcript`, and raw
    // reseed replayed the prior transcript under whatever auth was current.
    // Recording the clearing turn's identity keeps the reseed (identity
    // unchanged) without giving up the refusal (identity changed).
    const entry = { sessionId: "s1" } as SessionEntry;
    setCliSessionId(entry, "claude-cli", "sid-bare");
    expect(entry.cliSessionBindings?.["claude-cli"]?.authProfileId).toBeUndefined();

    clearCliSession(entry, "claude-cli", cliSessionClearAuthFromRun(currentIdentity));

    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBeUndefined();
    expect(reuseAfterClear(entry, currentIdentity)).toEqual({ mode: "none" });
  });

  it("refuses the reseed when the identity changed after a bare binding's clear", () => {
    const entry = { sessionId: "s1" } as SessionEntry;
    setCliSessionId(entry, "claude-cli", "sid-bare");
    clearCliSession(entry, "claude-cli", cliSessionClearAuthFromRun(currentIdentity));

    expect(
      reuseAfterClear(entry, {
        authProfileId: "anthropic:other",
        authEpoch: "epoch-other",
        authEpochVersion: 1,
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
  });

  it("leaves a tombstone when legacy rows are the only record", () => {
    // Legacy `cliSessionIds` / `claudeCliSessionId` rows predate bindings and
    // carry no identity at all. Erasing them was the same markerless delete.
    const entry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      cliSessionIds: { "claude-cli": "sid-legacy" },
      claudeCliSessionId: "sid-legacy",
    };

    clearCliSession(entry, "claude-cli", cliSessionClearAuthFromRun(currentIdentity));

    expect(entry.cliSessionIds).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual(currentIdentity);
    expect(
      reuseAfterClear(entry, {
        authProfileId: "anthropic:other",
        authEpoch: "epoch-other",
        authEpochVersion: 1,
      }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
  });

  it("records an install with no auth identity as an identity, not as nothing", () => {
    // Neither profile nor epoch resolves on this install. The empty identity is
    // still a fact: the next turn matches it and reseeds, but a profile or epoch
    // appearing later reads as a crossing rather than as "never bound".
    const entry = { sessionId: "s1" } as SessionEntry;
    setCliSessionId(entry, "claude-cli", "sid-bare");

    clearCliSession(entry, "claude-cli", cliSessionClearAuthFromRun({ authEpochVersion: 1 }));

    expect(reuseAfterClear(entry, { authEpochVersion: 1 })).toEqual({ mode: "none" });
    expect(reuseAfterClear(entry, { authProfileId: "anthropic:new", authEpochVersion: 1 })).toEqual(
      {
        mode: "invalidate",
        invalidatedReason: "auth-profile",
      },
    );
  });

  it("never fabricates an identity for a clear that resolved none", () => {
    // The trap: an identity-shaped tombstone written here would be *compared*
    // against the next turn's identity, and an empty one answers `auth-profile`
    // against every run that has a profile — refusing the reseed on every
    // bare-binding clear, which is #124991 again. So the unknown-provenance
    // tombstone carries no identity fields at all; it is recognized by its own
    // marker and answers `auth-unknown`, which is not an identity comparison.
    const entry = { sessionId: "s1" } as SessionEntry;
    setCliSessionId(entry, "claude-cli", "sid-bare");

    clearCliSession(entry, "claude-cli", CLI_SESSION_CLEAR_AUTH_UNKNOWN);

    expect(entry.cliSessionBindings?.["claude-cli"]).toStrictEqual({
      clearedAuthProvenance: "unknown",
    });
    expect(
      reuseAfterClear(entry, { authProfileId: "anthropic:current", authEpochVersion: 1 }),
    ).toEqual({ mode: "invalidate", invalidatedReason: "auth-unknown" });
  });

  it("prefers the binding's own identity over the clearing turn's", () => {
    const entry = { sessionId: "s1" } as SessionEntry;
    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "sid-prev",
      authProfileId: "anthropic:written-under",
      authEpoch: "epoch-written-under",
      authEpochVersion: 1,
    });

    clearCliSession(entry, "claude-cli", cliSessionClearAuthFromRun(currentIdentity));

    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      authProfileId: "anthropic:written-under",
      authEpoch: "epoch-written-under",
      authEpochVersion: 1,
    });
  });

  it("reports the run's auth identity on results that ask for a clear", () => {
    // The store writers get the identity off `agentMeta`; without it every
    // result-driven clear would fall back to unknown provenance.
    const result = buildSettlementResult({
      mode: "invalidate",
      invalidatedReason: "auth-profile",
    });
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    expect(result.meta.agentMeta?.cliSessionAuthIdentity).toEqual({ authEpochVersion: 0 });
  });
});

describe("isCliBindingFlushed", () => {
  const workspaceDir = "/tmp/openclaw-workspace";

  beforeEach(() => {
    vi.useRealTimers();
    restoreCliRunnerTestDeps();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    restoreCliRunnerTestDeps();
  });

  it("returns false when no sessionId is provided", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed(undefined, "claude-cli")).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true when the transcript has content on the first probe", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-fresh", "claude-cli", workspaceDir)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith({ sessionId: "sid-fresh", workspaceDir });
  });

  it("retries up to three times before giving up", async () => {
    const delay = vi.fn(async () => undefined);
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe, delay });

    expect(await isCliBindingFlushed("sid-cold", "claude-cli", workspaceDir)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 50);
    expect(delay).toHaveBeenNthCalledWith(2, 150);
  });

  it("succeeds when the transcript becomes visible on a later retry", async () => {
    const delay = vi.fn(async () => undefined);
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return calls >= 2;
    });
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe, delay });

    expect(await isCliBindingFlushed("sid-late", "claude-cli", workspaceDir)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledExactlyOnceWith(50);
  });

  it("schedules at most 0 + 50 + 150ms of delay across the bounded retry", async () => {
    vi.useFakeTimers();
    try {
      // Fake timers enforce the retry contract without introducing wall-clock
      // sleeps into this import-heavy agent test.
      const probe = vi.fn(async () => false);
      setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

      const settled = vi.fn();
      const errored = vi.fn();
      isCliBindingFlushed("sid-bounded", "claude-cli", workspaceDir).then(settled, errored);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(150);

      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled.mock.calls[0]?.[0]).toBe(false);
      expect(errored).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("returns true without probing for non-claude-cli providers", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-codex", "codex-cli")).toBe(true);
    expect(await isCliBindingFlushed("sid-anthropic", "anthropic")).toBe(true);
    expect(await isCliBindingFlushed("sid-openai", "openai")).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true without probing when provider is undefined", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(await isCliBindingFlushed("sid-x", undefined)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true without probing when the caller owns continuity outside native transcripts", async () => {
    const probe = vi.fn(async () => false);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(
      await isCliBindingFlushed("sid-warm", "claude-cli", workspaceDir, {
        skipTranscriptProbe: true,
      }),
    ).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("still probes when transcript-probe skipping is disabled", async () => {
    const probe = vi.fn(async () => true);
    setCliRunnerTestDeps({ claudeCliSessionTranscriptHasContent: probe });

    expect(
      await isCliBindingFlushed("sid-probe", "claude-cli", workspaceDir, {
        skipTranscriptProbe: false,
      }),
    ).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
