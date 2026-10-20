import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  assertSessionWriterDeliveryAuthorized,
  createSessionWriterDeliveryPreparation,
  isDispatchFinalReplySessionWriterAuthorized,
} from "../auto-reply/reply/session-writer-delivery-authority.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { loadSessionTranscriptEvents as loadTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createCliDispatchTranscriptRecorder } from "./embedded-agent-runner/cli-backend-dispatch-transcript.js";
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
let other: typeof actor;
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
  setRuntimeConfigSnapshot({});
  sql = observeHostDataSql();
});
afterEach(() => {
  try {
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  }
});
beforeAll(() => {
  actor = openOwner("command-runtime-incognito-");
  other = openOwner("command-runtime-other-root-");
});
afterAll(async () => {
  for (const binding of bindings) {
    await binding.actor.release();
  }
  memorySessionActorOwners.closeDatabase(actor);
  memorySessionActorOwners.closeDatabase(other);
});

async function create(name: string, patch: Partial<SessionEntry> = {}, owner = actor) {
  const controller = new AbortController();
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
        controller.signal.throwIfAborted();
      },
    },
  );
  const binding = { actor: handle, authority, agentId: owner.agentId, path: owner.path };
  bindings.push(binding);
  expect(
    await handle.storage!.mutate({ type: "session.entry.create", input: { entry } }, authority),
  ).toMatchObject({ kind: "committed" });
  const target = { agentId: "main", storePath: owner.path, sessionKey, sessionId: entry.sessionId };
  return {
    target,
    entry,
    run: <T>(callback: () => T) => runWithSessionActorStorage(binding, callback),
    read: () => owner.readSession(sessionKey, authority)?.entry,
    abort: (message: string) => {
      controller.abort(new Error(message));
      expect(() => handle.assertReadable()).toThrow(message);
    },
  };
}

async function messages(target: Awaited<ReturnType<typeof create>>["target"]) {
  return (await loadTranscriptEvents(target)).flatMap((event) =>
    isRecord(event) && event.type === "message" ? [event.message] : [],
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

it("settles queued CLI records on their captured actor after abort and outside the binding", async () => {
  const { target, run, abort } = await create("cli-records", { activeWriterRunId: "cli-run" });
  const foreign = await create("cli-records", { activeWriterRunId: "cli-run" }, other);
  const recorder = run(() =>
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
  foreign.run(() => {
    const tool = { toolName: "read", toolCallId: "tool-1" };
    recorder.noteToolEvent({ phase: "start", ...tool });
    recorder.noteToolEvent({ phase: "result", ...tool, result: "private result" });
    recorder.noteAssistantText("partial private reply");
  });
  // Abort before the recorder's Promise FIFO can start its first append.
  abort("run stopped");
  recorder.flushAssistantSnapshot();
  await recorder.finalize();

  expect(await messages(target)).toMatchObject([
    { role: "user", content: [{ text: "private prompt" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "tool-1" }] },
    { role: "toolResult", content: [{ text: "private result" }] },
    { role: "assistant", content: [{ text: "partial private reply" }], stopReason: "aborted" },
  ]);
  expect(await messages(foreign.target)).toEqual([]);
});

it("rolls back a failed model and appends its visible note to the original actor after cancellation", async () => {
  const { target, run, read, abort } = await create("rollback", patchedModel);
  const foreign = await create("rollback", patchedModel, other);
  const onError = vi.fn();
  const guard = await run(() =>
    createAgentPatchedSessionModelRunGuard({ ...target, cfg: {}, onError }),
  );
  abort("run finished");
  await foreign.run(() => guard.fail(new Error("model unavailable"), "model_not_found"));

  expect(onError).not.toHaveBeenCalled();
  const reverted = read();
  expect(reverted).toMatchObject({ model: "gpt-4o", modelOverride: "gpt-4o" });
  expect(reverted?.modelFallback).toBeUndefined();
  expect(await messages(target)).toContainEqual(
    expect.objectContaining({
      role: "custom",
      customType: "openclaw.system-note",
      display: true,
      content: "System note: model openai/gpt-4.1 failed; reverted to openai/gpt-4o.",
    }),
  );
  expect(foreign.read()).toMatchObject(patchedModel);
  expect(await messages(foreign.target)).toEqual([]);
});

it("does not roll a replacement session back using a previous incarnation's model guard", async () => {
  const { target, entry, run, read } = await create("rollback-replaced", patchedModel);
  const onError = vi.fn();
  const guard = await run(() =>
    createAgentPatchedSessionModelRunGuard({ ...target, cfg: {}, onError }),
  );
  await run(() =>
    replaceSessionEntry(target, { ...entry, sessionId: "replacement", lifecycleRevision: "next" }),
  );
  await guard.fail(new Error("late failed model"), "model_not_found");

  expect(onError).not.toHaveBeenCalled();
  expect(read()).toMatchObject({
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
    const { target, entry, run } = await create(`final-delivery-${hasStorePath}`, {
      activeWriterRunId: "first-writer",
    });
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
    const result = await run(() =>
      persistPendingFinalDeliveryMarker({
        ...target,
        deliver: true,
        sessionStore: { [target.sessionKey]: entry },
        sessionEntry: entry,
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads: [payload],
        deliveryContext: { channel: "discord", to: "channel:synthetic" },
        runOwnedSessionId: target.sessionId,
      }),
    );

    expect(result.pendingFinalDeliveryMarkerPersisted).toBe(true);
    let release = () => {};
    const prepareDelivery = createSessionWriterDeliveryPreparation({
      storePath: target.storePath,
      retain: (dispose) => {
        release = dispose;
      },
    });
    await prepareDelivery(payload);
    const deliveryAuthority = () =>
      getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
    const assertDelivery = () => assertSessionWriterDeliveryAuthorized(deliveryAuthority());
    try {
      expect(deliveryAuthority()?.readCurrentSession).toBeTypeOf("function");
      expect(isDispatchFinalReplySessionWriterAuthorized(payload)).toBe(true);
      expect(assertDelivery).not.toThrow();
      await run(() =>
        patchSessionEntryCore(target, () => ({ activeWriterRunId: "replacement-writer" })),
      );
      expect(isDispatchFinalReplySessionWriterAuthorized(payload)).toBe(false);
      expect(assertDelivery).toThrow(/writer changed/i);
    } finally {
      release();
    }
  },
);
