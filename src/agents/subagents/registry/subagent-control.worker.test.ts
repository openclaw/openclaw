// Preserve the real registry fixture before importing its runtime consumers.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { existsSync } from "node:fs";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../../../sessions/session-lifecycle-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { createOpenClawTools } from "../../openclaw-tools.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { resolveStoredSubagentCapabilities } from "../spawn/subagent-capabilities.js";
import { holdQueuedSwarmRun, releaseSwarmRun, reserveSwarmRun } from "../swarm/swarm-scheduler.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as registryState from "./subagent-registry-state.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";

const fixture = useSubagentControlFixture();
const nativeState = await vi.importActual<typeof registryState>("./subagent-registry-state.js");

it.each(["caller admission", "session generation"] as const)(
  "releases an acknowledged native claim when %s retires before publication",
  async (retirement) => {
    const runId = "retired-after-claim-ack";
    const sessionKey = `agent:main:subagent:${runId}`;
    const sessionId = `${runId}-session`;
    replaceSessionEntrySync(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: Date.now(), lifecycleRevision: "original" },
    );
    await registerSubagentRun({
      runId,
      childSessionKey: sessionKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "Stop admitted work",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    const caller = new AbortController();
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId, abort });
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    let retiredAfterAck = false;
    vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
      (runs, ids, options) => {
        const claim = runs.get(runId)?.killIntent;
        return nativeState.persistSubagentRunsToDiskAsyncOrThrow(runs, ids, {
          ...options,
          onCommitted() {
            if (claim && !retiredAfterAck) {
              retiredAfterAck = true;
              if (retirement === "caller admission") {
                caller.abort(new Error("Caller retired after commit"));
              } else {
                replaceSessionEntrySync(
                  { agentId: "main", sessionKey },
                  { sessionId, updatedAt: Date.now(), lifecycleRevision: "replacement" },
                );
              }
            }
            options.onCommitted?.();
          },
        });
      },
    );
    const tool = createOpenClawTools({
      config: getRuntimeConfig(),
      agentSessionKey: "agent:main:main",
      workspaceDir: fixture.stateDir,
      disableMessageTool: true,
    }).find((candidate) => candidate.name === "subagents");
    if (!tool) {
      throw new Error("Missing registered subagents tool");
    }
    // The session-rotation cell deliberately writes through the native fixture owner.
    const sql = retirement === "caller admission" ? observeMainThreadSql() : undefined;
    sql?.calibrate();
    let counts: number[] | undefined;
    try {
      const cancellation = tool.execute(
        "retired-caller-stop",
        { action: "cancel", runId },
        caller.signal,
      );
      if (retirement === "caller admission") {
        await expect(cancellation).rejects.toThrow("Caller retired after commit");
      } else {
        expect((await cancellation).details).toMatchObject({ found: true, killed: false });
      }
      await fixture.settle();
    } finally {
      counts = sql?.calls.map((probe) => probe.mock.calls.length);
      sql?.restore();
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
    expect(retiredAfterAck).toBe(true);
    expect(abort).not.toHaveBeenCalled();
    const persisted = loadSubagentRegistryFromSqlite().get(runId);
    expect(
      persisted?.killIntent,
      "a committed claim remains owned until it is released",
    ).toBeUndefined();
    expect(persisted?.execution.endedAt).toBeUndefined();
    if (counts) {
      expect(counts).toEqual(counts.map(() => 0));
    } else {
      expect(loadExactSessionEntryReadOnly({ agentId: "main", sessionKey })?.entry).toMatchObject({
        sessionId,
        lifecycleRevision: "replacement",
      });
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", sessionKey })?.entry.abortedLastRun,
      ).not.toBe(true);
    }
  },
);

it.each(["same-ID replacement", "cold hydration"] as const)(
  "preserves registered Stop selection across %s",
  async (kind) => {
    await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
      vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
        nativeState.persistSubagentRunsToDiskAsyncOrThrow,
      );
      const runId = "replace-during-control-preparation";
      const sessionKey = `agent:main:subagent:${runId}`;
      const sessionId = `${runId}-session`;
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: Date.now(), lifecycleRevision: "same-session" },
      );
      const registration = {
        runId,
        childSessionKey: sessionKey,
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: "original",
        cleanup: "keep" as const,
        expectsCompletionMessage: false,
      };
      await registerSubagentRun(registration);
      const original = subagentRuns.get(runId)!;
      if (kind === "cold hydration") {
        subagentRuns.clear();
      }
      const tool = createOpenClawTools({
        config: getRuntimeConfig(),
        agentSessionKey: "agent:main:main",
        workspaceDir: fixture.stateDir,
        disableMessageTool: true,
      }).find((candidate) => candidate.name === "subagents");
      if (!tool) {
        throw new Error("Missing registered subagents tool");
      }
      registryState.clearSubagentRunsReadCacheForTest();
      const entered = createDeferred();
      const release = createDeferred();
      vi.mocked(registryState.prepareSubagentSessionListReadCache).mockImplementationOnce(
        async () => {
          entered.resolve();
          await release.promise;
          await nativeState.prepareSubagentSessionListReadCache();
        },
      );
      const abort = vi.fn(() => clearActiveEmbeddedRun(sessionId, handle, sessionKey));
      const handle = createEmbeddedRunHandle({ runId, abort });
      const pending = tool
        .execute("prepared-stop", { action: "cancel", runId })
        .catch((error: unknown) => error);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Stop skipped control preparation");
          }),
        ]);
        if (kind === "same-ID replacement") {
          await registerSubagentRun({ ...registration, task: "successor" });
        } else {
          // The existing startup owner hydrates the persisted row; this is not an absence witness.
          expect(
            await nativeState.restoreSubagentRunsFromDisk({ runs: subagentRuns }),
          ).toBeGreaterThan(0);
        }
        const successor = subagentRuns.get(runId)!;
        expect(successor).not.toBe(original);
        if (kind === "same-ID replacement") {
          expect(successor.generation).toBeGreaterThan(original.generation!);
        } else {
          expect(successor.generation).toBe(original.generation);
        }
        setActiveEmbeddedRun(sessionId, handle, sessionKey);
        release.resolve();
        const outcome = await pending;
        await fixture.settle();
        if (kind === "same-ID replacement") {
          expect(abort, "Stop must not transfer to newly registered work").not.toHaveBeenCalled();
          expect(outcome).toBeInstanceOf(Error);
          expect(successor.execution.endedAt).toBeUndefined();
        } else {
          expect(outcome).toMatchObject({ details: { found: true, killed: true } });
          expect(abort).toHaveBeenCalledOnce();
          expect(loadSubagentRegistryFromSqlite().get(runId)?.endedReason).toBe("subagent-killed");
        }
      } finally {
        release.resolve();
        await pending;
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }
    });
  },
);

it.each([
  "active",
  "queued",
  "queued without child store",
  "completion",
  "subagent caller",
  "subagent caller with opaque id",
  "subagent caller with cross-agent key",
  "earlier success",
] as const)("settles registered runId Stop for an %s native child", async (kind) =>
  withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
    vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
      nativeState.persistSubagentRunsToDiskAsyncOrThrow,
    );
    const runId = `native-run-stop-${kind.replaceAll(" ", "-")}`;
    const siblingId = `${runId}-untouched`;
    const missingStore = kind === "queued without child store";
    const queued = kind === "queued" || missingStore;
    const missingPath = resolveOpenClawAgentSqlitePath({ agentId: "missing" });
    const key = (id: string) =>
      `agent:${missingStore && id === runId ? "missing" : "main"}:subagent:${id}`;
    const capacityOwner = `${runId}-capacity`;
    const subagentCaller = kind.startsWith("subagent caller");
    const opaqueParentId = kind === "subagent caller with opaque id";
    const keyedParent = kind === "subagent caller with cross-agent key";
    const earlierSuccess = kind === "earlier success";
    const completesDuringStop = kind === "completion" || earlierSuccess;
    const fixtureStartedAt = Date.now();
    const clock = earlierSuccess
      ? vi.spyOn(Date, "now").mockReturnValue(fixtureStartedAt)
      : undefined;
    if (clock) {
      onTestFinished(() => clock.mockRestore());
    }
    const endedHook = vi.fn(async () => {});
    if (earlierSuccess) {
      const registry = createMockPluginRegistry([
        { hookName: "subagent_ended", handler: endedHook },
      ]);
      vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(registry);
      initializeGlobalHookRunner(registry);
      onTestFinished(resetGlobalHookRunner);
      fixture.capture.mockResolvedValue("Completed before Stop");
    }
    const requester = subagentCaller ? "agent:main:subagent:controller" : "agent:main:main";
    const config = structuredClone(getRuntimeConfig());
    if (subagentCaller) {
      const parentId = `agent:${opaqueParentId ? "other" : "main"}:subagent:parent-by-session-id`;
      const parentAgentId = keyedParent ? "other" : "main";
      const parentKey = `agent:${parentAgentId}:controller-parent`;
      config.agents = {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          subagents: { ...config.agents?.defaults?.subagents, maxSpawnDepth: 2 },
        },
      };
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: requester },
        {
          sessionId: "controller-session",
          updatedAt: Date.now(),
          lifecycleRevision: "controller-original",
          spawnedBy: keyedParent ? parentKey : parentId,
        },
      );
      replaceSessionEntrySync(
        { agentId: parentAgentId, sessionKey: parentKey },
        {
          sessionId: keyedParent ? "controller-parent-session" : parentId,
          updatedAt: Date.now(),
          spawnDepth: 0,
        },
      );
      if (opaqueParentId) {
        replaceSessionEntrySync(
          { agentId: "other", sessionKey: "agent:other:controller-decoy" },
          { sessionId: parentId, updatedAt: Date.now(), spawnDepth: 7 },
        );
      }
      expect(
        resolveStoredSubagentCapabilities(requester, { cfg: config, agentId: "main" }),
      ).toMatchObject({ controlScope: "children" });
    }
    const terminalEntered = createDeferred();
    const terminalRelease = createDeferred();
    let heldTerminal = false;
    let admission: SessionWorkAdmissionLease | undefined;
    let runnerSettlement: Promise<void> | undefined;
    if (completesDuringStop) {
      vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
        (runs, ids, options) => {
          if (
            !heldTerminal &&
            ids.includes(runId) &&
            runs.get(runId)?.execution.status === "terminal"
          ) {
            heldTerminal = true;
            const snapshot = structuredClone(runs);
            terminalEntered.resolve();
            return terminalRelease.promise.then(() =>
              nativeState.persistSubagentRunsToDiskAsyncOrThrow(snapshot, ids, options),
            );
          }
          return nativeState.persistSubagentRunsToDiskAsyncOrThrow(runs, ids, options);
        },
      );
    }
    if (queued) {
      expect(
        reserveSwarmRun({
          runId,
          groupId: runId,
          maxConcurrent: 1,
          activeRunIds: [capacityOwner],
        }),
      ).toBe(true);
    }
    for (const id of [runId, siblingId]) {
      // Fixture seeding ends before the observed Stop, without scheduling maintenance tails.
      if (!missingStore || id !== runId) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: key(id) },
          {
            sessionId: `${id}-session`,
            updatedAt: Date.now(),
            lifecycleRevision: `${id}-revision`,
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18,
          },
        );
      }
      await registerSubagentRun({
        runId: id,
        childSessionKey: key(id),
        requesterSessionKey: requester,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: id,
        cleanup: "keep",
        collect: queued && id === runId,
        queued: queued && id === runId,
        expectsCompletionMessage: false,
      });
    }
    if (missingStore) {
      expect(existsSync(missingPath)).toBe(false);
    }
    const handles = [runId, siblingId]
      .filter((id) => !queued || id !== runId)
      .map((id) => {
        const sessionId = `${id}-session`;
        const abort = vi.fn(() => clearActiveEmbeddedRun(sessionId, handle, key(id)));
        const handle = createEmbeddedRunHandle({ abort, runId: id });
        setActiveEmbeddedRun(sessionId, handle, key(id));
        return { id, sessionId, handle, abort };
      });
    const tool = createOpenClawTools({
      config,
      agentSessionKey: requester,
      workspaceDir: fixture.stateDir,
      disableMessageTool: true,
    }).find((candidate) => candidate.name === "subagents");
    expect(tool, "core must register the native subagents tool").toBeDefined();
    if (!tool) {
      throw new Error("Missing registered subagents tool");
    }
    const completedAtBeforeStop = earlierSuccess ? fixtureStartedAt + 1 : Date.now();
    clock?.mockReturnValue(fixtureStartedAt + 2);
    if (completesDuringStop) {
      admission = await beginSessionWorkAdmission({
        scope: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
          agentId: "main",
        }),
        identities: [key(runId), `${runId}-session`],
        assertAllowed: () => {},
        onInterrupt: () => {
          handles.find(({ id }) => id === runId)!.abort();
          if (earlierSuccess) {
            expect(subagentRuns.get(runId)?.killIntent?.requestedAt).toBeGreaterThan(
              completedAtBeforeStop,
            );
          }
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: earlierSuccess
              ? { phase: "end", status: "ok", endedAt: completedAtBeforeStop }
              : { phase: "end", status: "error", aborted: true, endedAt: Date.now() },
          });
          runnerSettlement = fixture.settle().finally(() => admission?.release());
        },
      });
    }
    await fixture.settle();
    registryState.clearSubagentRunsReadCacheForTest();
    const sql = observeMainThreadSql();
    sql.calibrate();
    let counts: number[];
    let unexpectedHold: ReturnType<typeof holdQueuedSwarmRun>;
    let cancellation: ReturnType<typeof tool.execute> | undefined;
    try {
      let settled = false;
      cancellation = tool
        .execute("registered-native-stop", { action: "cancel", runId })
        .then((result) => {
          settled = true;
          return result;
        });
      if (completesDuringStop) {
        await Promise.race([
          terminalEntered.promise,
          cancellation.then(() => {
            throw new Error("Stop settled before its terminal writer was admitted");
          }),
        ]);
        expect(settled, "Stop joins the runner's held terminal publication").toBe(false);
        terminalRelease.resolve();
      }
      const result = await cancellation;
      expect(result.details, JSON.stringify(result.details)).toMatchObject({
        found: true,
        killed: !earlierSuccess,
        runId,
        ...(earlierSuccess ? { targetState: { task: { status: "succeeded" } } } : {}),
      });
      // Include required native finalization work, including tails the baseline fails to await.
      await fixture.settle();
      await runnerSettlement;
    } finally {
      terminalRelease.resolve();
      admission?.release();
      await Promise.allSettled([runnerSettlement, cancellation]);
      counts = sql.calls.map((probe) => probe.mock.calls.length);
      sql.restore();
      if (earlierSuccess) {
        // Ordinary success cleanup shares this observed window; its composed proof owns
        // the whole-window zero-SQL assertion after the separate owner cutover.
        console.info("Earlier-success Stop SQL, including ordinary cleanup", {
          counts,
        });
        resetGlobalHookRunner();
      }
      for (const { id, sessionId, handle } of handles) {
        clearActiveEmbeddedRun(sessionId, handle, key(id));
      }
      releaseSwarmRun(capacityOwner);
      if (missingStore) {
        expect
          .soft(existsSync(missingPath), "Stop must not provision the missing child store")
          .toBe(false);
      }
    }
    try {
      const persisted = loadSubagentRegistryFromSqlite();
      expect(persisted.get(runId)).toMatchObject({
        execution: {
          status: "terminal",
          ...(earlierSuccess ? { outcome: { status: "ok" } } : {}),
        },
        endedReason: earlierSuccess ? "subagent-complete" : "subagent-killed",
        ...(earlierSuccess
          ? {
              endedHookEmittedAt: expect.any(Number),
              completion: { resultText: "Completed before Stop" },
            }
          : {}),
      });
      expect(persisted.get(siblingId)?.execution.endedAt).toBeUndefined();
      if (!missingStore) {
        expect(
          loadExactSessionEntryReadOnly({ agentId: "main", sessionKey: key(runId) })?.entry,
        ).toMatchObject({
          ...(earlierSuccess
            ? { status: "done" }
            : kind === "completion"
              ? { status: "killed" }
              : { abortedLastRun: true }),
          endedAt: expect.any(Number),
        });
      }
      expect(handles.find(({ id }) => id === siblingId)?.abort).not.toHaveBeenCalled();
      if (!queued) {
        expect(handles.find(({ id }) => id === runId)?.abort).toHaveBeenCalledOnce();
      } else {
        unexpectedHold = holdQueuedSwarmRun(runId);
        expect(unexpectedHold).toBeUndefined();
        if (!missingStore) {
          expect(persisted.get(runId)?.collectorCompletion?.usage).toMatchObject({
            inputTokens: 11,
            outputTokens: 7,
          });
        }
      }
      if (earlierSuccess) {
        expect(endedHook).toHaveBeenCalledOnce();
        expect(
          loadExactSessionEntryReadOnly({ agentId: "main", sessionKey: key(runId) })?.entry
            .abortedLastRun,
        ).not.toBe(true);
      } else {
        expect(counts).toEqual(counts.map(() => 0));
      }
    } finally {
      await unexpectedHold?.release();
    }
  }),
);
