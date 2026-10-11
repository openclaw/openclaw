import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  assertReplyPayloadSessionWriterDeliveryAuthorized,
  isDispatchFinalReplySessionWriterAuthorized,
} from "../auto-reply/reply/session-writer-delivery-authority.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { loadTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createCliDispatchTranscriptRecorder } from "./embedded-agent-runner/cli-backend-dispatch-transcript.js";
import {
  persistForceClearedEmbeddedRunTerminalState,
  tryLoadForceClearSessionSnapshot,
} from "./embedded-agent-runner/force-clear-session-state.js";
import {
  createInternalSessionEffectsCleanup,
  prepareInternalSessionEffectsSession,
  removeInternalSessionEffectsSession,
} from "./internal-session-effects.js";
import { persistPendingFinalDeliveryMarker } from "./pending-final-delivery-marker.js";
import { createAgentPatchedSessionModelRunGuard } from "./session-model-auto-revert.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {}, authorize() {} };
let actor: ReturnType<typeof memorySessionActorOwners.get>;
const bindings: SessionActorStorageBinding[] = [];
let sql: ReturnType<typeof observeHostDataSql>;
function openOwner(prefix: string) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make(prefix) };
  return memorySessionActorOwners.get({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  });
}
beforeEach(() => {
  sql = observeHostDataSql();
});
afterEach(() => {
  try {
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
    vi.unstubAllEnvs();
  }
});
beforeAll(() => {
  actor = openOwner("command-runtime-incognito-");
});
afterAll(async () => {
  for (const binding of bindings) {
    await binding.actor.release();
  }
  memorySessionActorOwners.closeDatabase(actor);
});

async function create(
  name: string,
  patch: Partial<SessionEntry> = {},
  owner = actor,
  signal?: AbortSignal,
) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const entry: SessionEntry = {
    sessionId: name,
    lifecycleRevision: "original",
    updatedAt: 1,
    incognito: true,
    ...patch,
  };
  const handle = await owner.acquire(
    { database: owner.identity, sessionKey },
    {
      assertCurrent() {},
      assertReadable() {
        signal?.throwIfAborted();
      },
    },
  );
  const binding = { actor: handle, authority, agentId: owner.agentId, path: owner.path };
  bindings.push(binding);
  expect(
    await handle.storage!.mutate({ type: "session.entry.create", input: { entry } }, authority),
  ).toMatchObject({ kind: "committed" });
  return {
    binding,
    target: { agentId: "main", storePath: owner.path, sessionKey, sessionId: entry.sessionId },
    entry,
  };
}

async function messages(target: Awaited<ReturnType<typeof create>>["target"]) {
  return (await loadTranscriptEvents(target)).filter(
    (event) => isRecord(event) && event.type === "message",
  );
}

const patchedModel = {
  model: "gpt-4.1",
  modelProvider: "openai",
  modelOverride: "gpt-4.1",
  providerOverride: "openai",
  modelOverrideRouteResolution: "resolved",
  modelFallback: {
    source: "agent-patch",
    ts: 42,
    prevModel: "gpt-4o",
    prevProvider: "openai",
    prevModelOverride: "gpt-4o",
    prevProviderOverride: "openai",
    prevModelOverrideRouteResolution: "resolved",
  },
} satisfies Partial<SessionEntry>;

describe("captured actor isolation", () => {
  let other: typeof actor;
  beforeAll(async () => {
    other = openOwner("command-runtime-other-root-");
  });
  afterAll(async () => {
    memorySessionActorOwners.closeDatabase(other);
  });

  it("settles queued CLI records on their captured actor after abort and outside the binding", async () => {
    const controller = new AbortController();
    const { target, binding } = await create(
      "cli-records",
      { activeWriterRunId: "cli-run" },
      actor,
      controller.signal,
    );
    const foreign = await create("cli-records", { activeWriterRunId: "cli-run" }, other);
    const recorder = runWithSessionActorStorage(binding, () =>
      createCliDispatchTranscriptRecorder({
        ...target,
        runId: "cli-run",
        prompt: "private prompt",
        provider: "openai",
        model: "gpt-4.1",
        expectedLifecycleRevision: "original",
        expectedWriterRunId: "cli-run",
      }),
    );
    runWithSessionActorStorage(foreign.binding, () => {
      recorder.noteToolEvent({ phase: "start", toolName: "read", toolCallId: "tool-1" });
      recorder.noteToolEvent({
        phase: "result",
        toolName: "read",
        toolCallId: "tool-1",
        result: "private result",
      });
      recorder.noteAssistantText("partial private reply");
    });
    // Abort before the recorder's Promise FIFO can start its first append.
    controller.abort(new Error("run stopped"));
    expect(() => binding.actor.assertReadable()).toThrow("run stopped");
    recorder.flushAssistantSnapshot();
    await recorder.finalize();

    expect(await messages(target)).toMatchObject([
      { message: { role: "user", content: [{ text: "private prompt" }] } },
      { message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1" }] } },
      { message: { role: "toolResult", content: [{ text: "private result" }] } },
      {
        message: {
          role: "assistant",
          content: [{ text: "partial private reply" }],
          stopReason: "aborted",
        },
      },
    ]);
    expect(await messages(foreign.target)).toEqual([]);
  });

  it("rolls back a failed model and appends its visible note to the original actor after cancellation", async () => {
    const controller = new AbortController();
    const { target, binding } = await create("rollback", patchedModel, actor, controller.signal);
    const foreign = await create("rollback", patchedModel, other);
    const onError = vi.fn();
    const guard = await runWithSessionActorStorage(binding, () =>
      createAgentPatchedSessionModelRunGuard({ ...target, cfg: {}, onError }),
    );
    controller.abort(new Error("run finished"));
    expect(() => binding.actor.assertReadable()).toThrow("run finished");
    await runWithSessionActorStorage(foreign.binding, () =>
      guard.fail(new Error("model unavailable"), "model_not_found"),
    );

    expect(onError).not.toHaveBeenCalled();
    const reverted = actor.readSession(target.sessionKey, authority)?.entry;
    expect(reverted).toMatchObject({
      model: "gpt-4o",
      modelOverride: "gpt-4o",
    });
    expect(reverted?.modelFallback).toBeUndefined();
    expect(await messages(target)).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          role: "custom",
          customType: "openclaw.system-note",
          display: true,
          content: "System note: model openai/gpt-4.1 failed; reverted to openai/gpt-4o.",
        }),
      }),
    );
    expect(other.readSession(foreign.target.sessionKey, authority)?.entry).toMatchObject(
      patchedModel,
    );
    expect(await messages(foreign.target)).toEqual([]);
  });
});

it("does not roll a replacement session back using a previous incarnation's model guard", async () => {
  const { target, entry, binding } = await create("rollback-replaced", patchedModel);
  const onError = vi.fn();
  const guard = await runWithSessionActorStorage(binding, () =>
    createAgentPatchedSessionModelRunGuard({ ...target, cfg: {}, onError }),
  );
  await runWithSessionActorStorage(binding, () =>
    replaceSessionEntry(target, { ...entry, sessionId: "replacement", lifecycleRevision: "next" }),
  );
  await guard.fail(new Error("late failed model"), "model_not_found");

  expect(onError).not.toHaveBeenCalled();
  expect(actor.readSession(target.sessionKey, authority)?.entry).toMatchObject({
    sessionId: "replacement",
    lifecycleRevision: "next",
    ...patchedModel,
  });
});

it("reopens hidden actor effects and deletes only their current owner", async () => {
  const params = { agentId: "main", storePath: actor.path, runId: "hidden-effects" };
  const hidden = await prepareInternalSessionEffectsSession(params);
  expect(await prepareInternalSessionEffectsSession(params)).toEqual(hidden);
  expect(hidden.sessionEntry).toMatchObject({ incognito: true, delivery: { kind: "internal" } });
  const owner = { lifecycleRevision: "hidden-revision", activeWriterRunId: "hidden-writer" };
  await patchSessionEntryCore(hidden, () => owner);
  await removeInternalSessionEffectsSession(hidden, {
    ...owner,
    activeWriterRunId: "old-writer",
  });
  expect(actor.readSession(hidden.sessionKey, authority)?.entry).toMatchObject(owner);
  await removeInternalSessionEffectsSession(hidden, owner);
  expect(actor.readSession(hidden.sessionKey, authority)?.entry).toBeUndefined();
});

it("settles unbound hidden cleanup on its original memory owner", async () => {
  const params = { agentId: "main", storePath: actor.path, runId: "hidden-canceled" };
  const hidden = await prepareInternalSessionEffectsSession(params);
  const cleanup = createInternalSessionEffectsCleanup({
    ...params,
    enabled: true,
    onError: (error) => {
      throw error;
    },
  });
  cleanup.track(hidden);
  await cleanup.cleanup();
  expect(actor.readSession(hidden.sessionKey, authority)?.entry).toBeUndefined();
});

it.each([true, false])(
  "retains final-delivery authority with a stored path: %s",
  async (hasStorePath) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.resolve(actor.path, "../../../.."));
    const { target, entry, binding } = await create(`final-delivery-${hasStorePath}`, {
      activeWriterRunId: "first-writer",
    });
    entry.restartRecoveryHarnessCompletion = {
      taskId: "task",
      taskRunId: "task-run",
      taskStatus: "succeeded",
      sourceRunId: "announce:task-run",
      requesterAgentId: "main",
      requesterSessionKey: target.sessionKey,
      sessionId: target.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
    };
    const payload = { text: "final private reply" };
    setReplyPayloadMetadata(payload, {
      sessionWriterDeliveryAuthority: {
        ...target,
        storePath: hasStorePath ? target.storePath : undefined,
        expectedSessionId: target.sessionId,
        expectedLifecycleRevision: entry.lifecycleRevision,
        expectedWriterRunId: "first-writer",
      },
    });
    const result = await runWithSessionActorStorage(binding, async () => {
      await replaceSessionEntry(target, entry);
      return persistPendingFinalDeliveryMarker({
        ...target,
        deliver: true,
        sessionStore: { [target.sessionKey]: entry },
        sessionEntry: entry,
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads: [payload],
        deliveryContext: { channel: "discord", to: "channel:synthetic" },
        runOwnedSessionId: target.sessionId,
      });
    });

    expect(result.pendingFinalDeliveryMarkerPersisted).toBe(true);
    expect(isDispatchFinalReplySessionWriterAuthorized(payload)).toBe(true);
    expect(() => assertReplyPayloadSessionWriterDeliveryAuthorized(payload)).not.toThrow();
    await runWithSessionActorStorage(binding, () =>
      patchSessionEntryCore(target, () => ({ activeWriterRunId: "replacement-writer" })),
    );
    expect(isDispatchFinalReplySessionWriterAuthorized(payload)).toBe(false);
    expect(() => assertReplyPayloadSessionWriterDeliveryAuthorized(payload)).toThrow(
      /writer changed/i,
    );
  },
);

it.each([false, true])("force-clear preserves a later session update: %s", async (changed) => {
  const { target, binding } = await create(`force-clear-${changed}`, {
    lifecycleRunId: "running",
    startedAt: 1,
  });
  const snapshot = runWithSessionActorStorage(binding, () =>
    tryLoadForceClearSessionSnapshot(target.sessionKey, "main", "running"),
  );
  expect(snapshot).toBeDefined();
  if (!snapshot) {
    throw new Error("Missing force-clear snapshot");
  }
  if (changed) {
    await runWithSessionActorStorage(binding, () =>
      patchSessionEntryCore(target, () => ({ label: "updated during recovery", updatedAt: 2 })),
    );
  }
  await persistForceClearedEmbeddedRunTerminalState({ ...snapshot, ...target }, () => false);
  const entry = actor.readSession(target.sessionKey, authority)?.entry;
  expect(entry?.status).toBe(changed ? undefined : "killed");
  if (changed) {
    expect(entry?.label).toBe("updated during recovery");
  }
});
