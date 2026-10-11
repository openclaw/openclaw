import "../test-utils/prepare-compiled-subprocesses.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  assertReplyPayloadSessionWriterDeliveryAuthorized,
  isDispatchFinalReplySessionWriterAuthorized,
} from "../auto-reply/reply/session-writer-delivery-authority.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { loadTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "../state/openclaw-agent-execution-incognito.test-support.js";
import { createCliDispatchTranscriptRecorder } from "./embedded-agent-runner/cli-backend-dispatch-transcript.js";
import {
  createInternalSessionEffectsCleanup,
  prepareInternalSessionEffectsSession,
  removeInternalSessionEffectsSession,
} from "./internal-session-effects.js";
import { persistPendingFinalDeliveryMarker } from "./pending-final-delivery-marker.js";
import { createAgentPatchedSessionModelRunGuard } from "./session-model-auto-revert.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
useIncognitoNoHostSql();

beforeAll(async () => {
  actor = await openIncognitoTestActor(
    { OPENCLAW_STATE_DIR: tempDirs.make("command-runtime-incognito-") },
    authority,
  );
});
afterAll(async () => {
  await actor.close();
});

async function create(name: string, patch: Partial<SessionEntry> = {}, owner = actor) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const entry: SessionEntry = {
    sessionId: name,
    lifecycleRevision: "original",
    updatedAt: 1,
    incognito: true,
    ...patch,
  };
  await owner.sessions.create(authority, { sessionKey, entry });
  return {
    target: { agentId: "main", storePath: owner.path, sessionKey, sessionId: entry.sessionId },
    entry,
  };
}

async function messages(target: Awaited<ReturnType<typeof create>>["target"], owner = actor) {
  return withIncognitoSessionActor(owner, async () =>
    (await loadTranscriptEvents(target)).filter(
      (event) => isRecord(event) && event.type === "message",
    ),
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
  let other: Awaited<ReturnType<typeof openIncognitoTestActor>>;
  beforeAll(async () => {
    other = await openIncognitoTestActor(
      { OPENCLAW_STATE_DIR: tempDirs.make("command-runtime-other-root-") },
      authority,
    );
  });
  afterAll(async () => {
    await other.close();
  });

  it("settles queued CLI records on their captured actor after abort and outside the binding", async () => {
    const { target } = await create("cli-records", { activeWriterRunId: "cli-run" });
    const foreign = await create("cli-records", { activeWriterRunId: "cli-run" }, other);
    const controller = new AbortController();
    const recorder = withIncognitoSessionBinding(
      { actor, admissionSignal: controller.signal },
      () =>
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
    withIncognitoSessionBinding({ actor: other }, () => {
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
    expect(await messages(foreign.target, other)).toEqual([]);
  });

  it("rolls back a failed model and appends its visible note to the original actor after cancellation", async () => {
    const { target } = await create("rollback", patchedModel);
    const foreign = await create("rollback", patchedModel, other);
    const controller = new AbortController();
    const onError = vi.fn();
    const guard = await withIncognitoSessionActor(
      actor,
      () => createAgentPatchedSessionModelRunGuard({ ...target, cfg: {}, onError }),
      controller.signal,
    );
    controller.abort(new Error("run finished"));
    await withIncognitoSessionBinding({ actor: other }, () =>
      guard.fail(new Error("model unavailable"), "model_not_found"),
    );

    expect(onError).not.toHaveBeenCalled();
    const reverted = (await actor.sessions.read(authority, target)).entry;
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
    expect((await other.sessions.read(authority, foreign.target)).entry).toMatchObject(
      patchedModel,
    );
    expect(await messages(foreign.target, other)).toEqual([]);
  });
});

it("does not roll a replacement session back using a previous incarnation's model guard", async () => {
  const { target, entry } = await create("rollback-replaced", patchedModel);
  const onError = vi.fn();
  const guard = await withIncognitoSessionActor(actor, () =>
    createAgentPatchedSessionModelRunGuard({ ...target, cfg: {}, onError }),
  );
  await withIncognitoSessionActor(actor, () =>
    replaceSessionEntry(target, { ...entry, sessionId: "replacement", lifecycleRevision: "next" }),
  );
  await guard.fail(new Error("late failed model"), "model_not_found");

  expect(onError).toHaveBeenCalledOnce();
  expect((await actor.sessions.read(authority, target)).entry).toMatchObject({
    sessionId: "replacement",
    lifecycleRevision: "next",
    ...patchedModel,
  });
});

it("reopens hidden actor effects and deletes only their current owner", async () => {
  await withIncognitoSessionActor(actor, async () => {
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
    expect((await actor.sessions.read(authority, hidden)).entry).toMatchObject(owner);
    await removeInternalSessionEffectsSession(hidden, owner);
    expect((await actor.sessions.read(authority, hidden)).entry).toBeUndefined();
  });
});

it("settles hidden cleanup on its original actor after the run is canceled", async () => {
  const controller = new AbortController();
  const params = { agentId: "main", storePath: actor.path, runId: "hidden-canceled" };
  const { hidden, cleanup } = await withIncognitoSessionActor(
    actor,
    async () => {
      const created = await prepareInternalSessionEffectsSession(params);
      const retainedCleanup = createInternalSessionEffectsCleanup({
        ...params,
        enabled: true,
        onError: (error) => {
          throw error;
        },
      });
      retainedCleanup.track(created);
      return { hidden: created, cleanup: retainedCleanup };
    },
    controller.signal,
  );
  controller.abort();
  await cleanup.cleanup();
  expect((await actor.sessions.read(authority, hidden)).entry).toBeUndefined();
});

it("retains final-delivery authority outside the actor binding and revokes it on writer replacement", async () => {
  const { target, entry } = await create("final-delivery", { activeWriterRunId: "first-writer" });
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
      expectedSessionId: target.sessionId,
      expectedLifecycleRevision: entry.lifecycleRevision,
      expectedWriterRunId: "first-writer",
    },
  });
  const result = await withIncognitoSessionActor(actor, async () => {
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
  expect(
    getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority?.readCurrentSession,
  ).toBeTypeOf("function");
  expect(isDispatchFinalReplySessionWriterAuthorized(payload)).toBe(true);
  expect(() => assertReplyPayloadSessionWriterDeliveryAuthorized(payload)).not.toThrow();
  await withIncognitoSessionActor(actor, () =>
    patchSessionEntryCore(target, () => ({ activeWriterRunId: "replacement-writer" })),
  );
  expect(isDispatchFinalReplySessionWriterAuthorized(payload)).toBe(false);
  expect(() => assertReplyPayloadSessionWriterDeliveryAuthorized(payload)).toThrow(
    /writer changed/i,
  );
});
