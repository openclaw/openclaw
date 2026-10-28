import { expect, it as baseIt, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "./agent-run-terminal-outcome.js";
import {
  clearCliSessionInStore,
  buildCliSessionForkRunParams,
  persistCliSessionBindingResult,
  persistStoppedFirstCliSessionInStore,
  restoreCliSessionForkInStore,
} from "./cli-session-store.js";
import { getCliSessionBinding, resolveCliSessionReuse } from "./cli-session.js";
import {
  createRunResult,
  loadPersistedSessionEntry,
  loadPersistedSessionStore,
  seedSessionStore,
  withTempSessionStore,
} from "./command/session-store.test-support.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

vi.mock("./model-selection.js", () => ({
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) =>
    ["claude-cli", "codex-cli", "google-gemini-cli"].includes(provider.trim().toLowerCase()),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

type Publication = Parameters<typeof persistCliSessionBindingResult>[0];
function createStoreFixture(storePath: string) {
  const sessionKey = "agent:main:explicit:cli-test";
  const sessionStore: Record<string, SessionEntry> = {};
  const target = { agentId: "main", provider: "claude-cli", sessionKey, storePath, sessionStore };
  const forkParams = { ...target, expectedCliSessionId: "claude-source-session" };
  return {
    target,
    sessionStore,
    forkParams,
    read: () => loadPersistedSessionEntry(storePath, sessionKey),
    async seed(entry: SessionEntry, durable: SessionEntry | null = entry) {
      sessionStore[sessionKey] = entry;
      if (durable) {
        await seedSessionStore(storePath, { [sessionKey]: durable });
      }
      return sessionStore;
    },
    publish: (result: EmbeddedAgentRunResult, options: Partial<Publication> = {}) =>
      persistCliSessionBindingResult({
        ...target,
        result,
        expectedSession: sessionStore[sessionKey],
        assertSettlementCurrent: () => {},
        ...options,
      }),
    fork: (options: Partial<Parameters<typeof buildCliSessionForkRunParams>[0]> = {}) =>
      buildCliSessionForkRunParams({ ...forkParams, ...options }, () => {}),
    clear: (options: Partial<Parameters<typeof clearCliSessionInStore>[0]> = {}) =>
      clearCliSessionInStore({ ...target, ...options }),
  };
}
const it = baseIt.extend<{ f: ReturnType<typeof createStoreFixture> }>({
  f: async ({ signal: _signal }, use) =>
    withTempSessionStore(({ storePath }) => use(createStoreFixture(storePath))),
});
function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "openclaw-session-1", updatedAt: 1, ...overrides };
}
function nativeResult(sessionId: string, clearing = false) {
  return createRunResult({
    provider: "claude-cli",
    model: "claude-sonnet-4-6",
    sessionId,
    ...(sessionId ? { cliSessionBinding: { sessionId } } : {}),
    ...(clearing ? { clearCliSessionBinding: true } : {}),
  });
}
function boundEntry(nativeSessionId: string, overrides: Partial<SessionEntry> = {}) {
  return makeSessionEntry({
    cliSessionBindings: {
      "claude-cli": { sessionId: nativeSessionId, authEpoch: "epoch-1" },
      "codex-cli": { sessionId: "codex-session" },
    },
    cliSessionIds: { "claude-cli": nativeSessionId, "codex-cli": "codex-session" },
    claudeCliSessionId: nativeSessionId,
    ...overrides,
  });
}

it.for(["publish", "clear"] as const)(
  "settles a successful CLI binding %s without caller-thread entry SQL",
  async (operation, { f }) => {
    const { storePath, sessionKey } = f.target;
    const sessionId = "test-openclaw-session";
    const clearing = operation === "clear";
    const sessionStore = await f.seed(
      clearing ? boundEntry("stale-cli-session", { sessionId }) : makeSessionEntry({ sessionId }),
    );
    const result = nativeResult(clearing ? "" : "cli-session-123", clearing);
    const refuse = (): never => {
      throw new Error("CLI settlement source changed");
    };
    const assertSettlementCurrent = captureSessionEntrySourceAssertion({
      scope: { agentId: "main", sessionKey, storePath },
      expected: { sessionId },
      fields: ["sessionId"],
      assertCurrent: () => {
        if (f.read()?.sessionId !== sessionId) {
          refuse();
        }
      },
      refuse,
    });
    const sql = observeHostDataSql();
    let settled: EmbeddedAgentRunResult;
    try {
      settled = await f.publish(result, { assertSettlementCurrent });
      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(settled).toBe(result);
    for (const entry of [
      sessionStore[sessionKey],
      loadPersistedSessionStore(storePath)[sessionKey],
    ]) {
      expect(entry?.sessionId).toBe(sessionId);
      expect(entry?.cliSessionBindings).toEqual(
        clearing
          ? { "codex-cli": { sessionId: "codex-session" } }
          : { "claude-cli": { sessionId: "cli-session-123" } },
      );
      expect(entry?.cliSessionIds).toEqual(
        clearing ? { "codex-cli": "codex-session" } : { "claude-cli": "cli-session-123" },
      );
      expect(entry?.claudeCliSessionId).toBeUndefined();
    }
  },
);

it.for([
  ["successful", {}, "failed"],
  [
    "failed",
    {
      error: { kind: "incomplete_turn", message: "Primary execution failure", fallbackSafe: true },
    },
    "failed",
  ],
  [
    "timed-out",
    { aborted: true, stopReason: "timeout", timeoutPhase: "provider", providerStarted: true },
    "hard_timeout",
  ],
  ["cancelled", { aborted: true, stopReason: "stop" }, "cancelled"],
] as const)(
  "retains a %s result when CLI binding publication fails",
  async ([_state, terminal, reason], { f }) => {
    await f.seed(makeSessionEntry({ sessionId: "local-session" }));
    const beforeEntry = f.read();
    const result: EmbeddedAgentRunResult = {
      payloads: [{ text: "Captured answer" }],
      didSendViaMessagingTool: true,
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSentTexts: ["Already delivered"],
      acceptedSessionSpawns: [
        {
          runId: "child",
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
        },
      ],
      meta: {
        durationMs: 25,
        finalAssistantVisibleText: "Captured answer",
        finalAssistantRawText: "Captured raw answer",
        terminalReply: {
          disposition: "visible",
          text: "Captured answer",
          modelRouteChange: "Captured route",
        },
        agentMeta: {
          sessionId: "native-session",
          provider: "fixture-cli",
          model: "fixture-model",
          usage: { input: 71, output: 9, total: 80 },
          cliSessionBinding: { sessionId: "native-session" },
        },
        ...terminal,
      },
    };
    const beforeResult = structuredClone(result);
    const failure = new Error("Synthetic persistence failure (password=fixture-secret);", {
      cause: new Error(`Synthetic storage cause ${"x".repeat(2_000)}`),
    });
    const settled = await f.publish(result, {
      provider: "fixture-cli",
      assertSettlementCurrent: () => {
        throw failure;
      },
    });
    const { payloads, meta: originalMeta, ...facts } = result;
    const { error: primaryError, ...meta } = originalMeta;
    expect(settled).toMatchObject({ ...facts, meta: { ...meta, replayInvalid: true } });
    expect(settled.payloads?.slice(0, -1)).toEqual(payloads);
    const diagnostic = settled.payloads?.at(-1);
    expect(diagnostic).toMatchObject({
      isError: true,
      text: expect.stringContaining("CLI session continuity could not be saved"),
    });
    expect(diagnostic?.text).toContain("Synthetic storage cause");
    expect(diagnostic?.text).not.toContain("fixture-secret");
    expect(diagnostic?.text?.length).toBeLessThanOrEqual(1_024);
    expect(settled.meta.error).toMatchObject({
      kind: primaryError?.kind ?? "incomplete_turn",
      fallbackSafe: false,
    });
    if (primaryError) {
      expect(settled.meta.error?.message).toContain(primaryError.message);
    }
    expect(
      buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase: "error",
        data: { ...settled.meta, error: settled.meta.error?.message },
      }).reason,
    ).toBe(reason);
    expect(settled).not.toBe(result);
    expect(result).toEqual(beforeResult);
    expect(f.read()).toEqual(beforeEntry);
  },
);
it.for(["aborted-publish", "aborted-clear", "closed-clear"])(
  "revalidates settlement at the commit edge for %s",
  async (operation, { f }) => {
    const source = makeSessionEntry({
      sessionId: "local-session",
      cliSessionBindings: { "claude-cli": { sessionId: "existing-native-session" } },
    });
    await f.seed(source);
    const before = f.read();
    const controller = new AbortController();
    let open = true;
    const settlement = f.publish(
      nativeResult("replacement-native-session", operation.endsWith("clear")),
      {
        abortSignal: controller.signal,
        assertSettlementCurrent: () => {
          if (!open) {
            throw new Error("owner closed");
          }
        },
      },
    );
    // The row is unchanged; revocation happens after async patch planning starts.
    if (operation.startsWith("closed")) {
      open = false;
    }
    controller.abort(new Error("run aborted"));
    if (operation === "aborted-clear") {
      await settlement;
      expect(f.read()?.cliSessionBindings).toBeUndefined();
    } else {
      expect(await settlement).toMatchObject({
        meta: {
          replayInvalid: true,
          error: {
            message: expect.stringContaining(
              operation.startsWith("closed") ? "owner closed" : "run aborted",
            ),
            fallbackSafe: false,
          },
        },
      });
      expect(f.read()).toEqual(before);
    }
  },
);

it.for([
  ["claim", true],
  ["restore", true],
  ["successor", true],
  ["successor", false],
] as const)(
  "%s preserves checkpoint and account checks with forceReuse=%s",
  async ([operation, forceReuse], { f }) => {
    const { storePath, sessionKey } = f.target;
    const sourceBinding = {
      sessionId: "claude-source-session",
      resumeCheckpointId: "assistant-before-turn",
      ...(forceReuse ? { forceReuse: true } : {}),
      authProfileId: "claude:work",
      authEpoch: "epoch-1",
      authEpochVersion: 3,
    };
    const source = makeSessionEntry({
      cliSessionBindings: {
        "claude-cli": {
          ...sourceBinding,
          ...(operation === "claim" ? { forkNextResume: true } : {}),
        },
      },
    });
    const sessionStore = await f.seed(source);
    await replaceSessionEntry({ storePath, sessionKey }, { ...source, label: "concurrent update" });
    const callbacks = f.fork();
    if (operation === "claim") {
      expect(await callbacks.claimCliSessionFork()).toBe(true);
    } else if (operation === "restore") {
      const restored = await restoreCliSessionForkInStore(f.forkParams);
      expect(restored?.cliSessionBindings?.["claude-cli"]?.forkNextResume).toBe(true);
    } else {
      await callbacks.persistCliSessionForkSuccessor("claude-fork-session");
    }
    for (const value of [sessionStore[sessionKey], f.read()]) {
      expect(value?.cliSessionBindings?.["claude-cli"]).toEqual({
        ...sourceBinding,
        sessionId: operation === "successor" ? "claude-fork-session" : "claude-source-session",
        ...(operation === "restore" ? { forkNextResume: true } : {}),
      });
      expect(value?.label).toBe("concurrent update");
    }
    if (operation === "claim") {
      await expect(callbacks.claimCliSessionFork()).resolves.toBe(false);
    }
    if (!forceReuse) {
      expect(
        resolveCliSessionReuse({
          binding: sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"],
          authProfileId: "claude:personal",
          authEpoch: "epoch-2",
          authEpochVersion: 3,
        }),
      ).toEqual({ mode: "invalidate", invalidatedReason: "auth-profile" });
    }
  },
);

it.for([
  ["publish", "session-replaced"],
  ["consume", "rebound"],
  ["consume", "deleted"],
  ["consume", "lifecycle-replaced"],
  ["consume", "writer-replaced"],
  ["consume", "claim-released"],
  ["restore", "claim-released"],
  ["successor", "claim-released"],
] as const)(
  "rejects a stale %s after the durable row is %s",
  async ([operation, durableState], { f }) => {
    const { sessionKey } = f.target;
    const sourceBinding = {
      sessionId: "claude-source-session",
      forceReuse: true,
      ...(operation === "consume" ? { forkNextResume: true as const } : {}),
    };
    const cached = makeSessionEntry({
      lifecycleRevision: "source-lifecycle",
      activeWriterRunId: "source-writer",
      cliSessionBindings: { "claude-cli": sourceBinding },
    });
    f.sessionStore[sessionKey] = cached;
    const beforeCache = structuredClone(f.sessionStore);
    const replacements: Partial<Record<typeof durableState, Partial<SessionEntry>>> = {
      "session-replaced": { sessionId: "openclaw-session-2" },
      "lifecycle-replaced": { lifecycleRevision: "replacement-lifecycle" },
      "writer-replaced": { activeWriterRunId: "replacement-writer" },
      rebound: {
        cliSessionBindings: {
          "claude-cli": { sessionId: "claude-other-session", forceReuse: true },
        },
      },
    };
    const durableEntry = { ...cached, ...replacements[durableState] };
    await f.seed(cached, durableState === "deleted" ? null : durableEntry);
    const before = f.read();

    let open = true;
    const callbacks = f.fork({
      assertCommitAllowed: () => {
        if (!open) {
          throw new Error("claim released");
        }
      },
    });
    const result =
      operation === "publish"
        ? f.publish(nativeResult("late-native-session"))
        : operation === "consume"
          ? callbacks.claimCliSessionFork()
          : operation === "restore"
            ? callbacks.restoreCliSessionFork()
            : callbacks.persistCliSessionForkSuccessor("claude-successor-session");

    if (durableState === "claim-released") {
      open = false;
      await expect(result).rejects.toThrow("claim released");
    } else if (operation === "consume") {
      expect(await result).toBe(false);
    } else {
      await result;
    }
    expect(f.sessionStore).toEqual(beforeCache);
    expect(f.read()).toEqual(before);
  },
);

it.for(["present", "missing-before-run", "missing-after-run", "missing-cache"] as const)(
  "clears only the selected binding when the session state is %s",
  async (row, { f }) => {
    const { sessionKey } = f.target;
    const source = boundEntry("claude-session-1", {
      modelProvider: "anthropic",
      model: "claude-opus-4-6",
    });
    const sessionStore = await f.seed(
      source,
      row === "present" || row === "missing-cache" ? source : null,
    );
    const before = structuredClone(source);
    const cleared = await f.clear({
      sessionKey: row === "missing-cache" ? "agent:main:explicit:missing" : sessionKey,
      ...(row === "missing-after-run" ? { expectedSessionId: source.sessionId } : {}),
    });
    const persisted = f.read();
    if (row === "missing-cache") {
      expect(cleared).toBeUndefined();
      expect(sessionStore[sessionKey]).toEqual(before);
      expect(persisted).toMatchObject(before);
      return;
    }
    if (row === "missing-after-run") {
      expect(persisted).toBeUndefined();
      return;
    }
    expect(sessionStore[sessionKey]).toEqual(cleared);
    for (const value of [cleared, persisted]) {
      expect(value).toMatchObject({
        sessionId: "openclaw-session-1",
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(value?.cliSessionBindings).toEqual({ "codex-cli": { sessionId: "codex-session" } });
      expect(value?.cliSessionIds).toEqual({ "codex-cli": "codex-session" });
      expect(value?.claudeCliSessionId).toBeUndefined();
    }
  },
);

const unbound = makeSessionEntry();
it.for([
  ["empty binding", unbound, unbound, "stopped-first-session", false],
  ["bound meanwhile", unbound, boundEntry("bound-meanwhile"), "bound-meanwhile", false],
  ["reset session", unbound, makeSessionEntry({ sessionId: "reset" }), undefined, false],
  [
    "released writer",
    makeSessionEntry({ activeWriterRunId: "old" }),
    makeSessionEntry({ activeWriterRunId: "new" }),
    undefined,
    false,
  ],
  ["closed turn", unbound, unbound, undefined, true],
] as const)(
  "persists a stopped first CLI session: %s",
  async ([_case, working, durable, expected, closed], { f }) => {
    await f.seed({ ...working }, { ...durable });
    const rejection = new Error("settlement closed");
    const persistence = persistStoppedFirstCliSessionInStore({
      ...f.target,
      binding: { sessionId: "stopped-first-session", authEpochVersion: 7 },
      expectedSession: { ...working },
      assertSettlementCurrent: () => {
        if (closed) {
          throw rejection;
        }
      },
    });
    if (closed) {
      await expect(persistence).rejects.toBe(rejection);
      expect(getCliSessionBinding(f.read(), "claude-cli")).toBeUndefined();
    } else {
      await persistence;
      expect(getCliSessionBinding(f.read(), "claude-cli")?.sessionId).toBe(expected);
    }
  },
);

it.for([
  ["cleared", makeSessionEntry(), undefined],
  ["replaced", boundEntry("other-writer"), "other-writer"],
] as const)(
  "keeps a resumed native binding another writer %s while the turn ran",
  async ([_case, durable, expected], { f }) => {
    await f.seed(boundEntry("resumed-native"), durable);
    await f.publish(nativeResult("resumed-native"));
    expect(getCliSessionBinding(f.read(), "claude-cli")?.sessionId).toBe(expected);
  },
);

it("publishes a newly minted native id over a concurrent clear", async ({ f }) => {
  await f.seed(boundEntry("resumed-native"), makeSessionEntry());
  await f.publish(nativeResult("minted-native"));
  expect(getCliSessionBinding(f.read(), "claude-cli")?.sessionId).toBe("minted-native");
});
