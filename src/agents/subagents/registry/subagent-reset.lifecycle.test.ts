// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  runSubagentStateWorkerOperation,
  useSubagentControlFixture,
} from "./subagent-control.test-support.js";
import { beforeEach, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../../../auto-reply/reply/inbound-context.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "../../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../../auto-reply/reply/queue.test-helpers.js";
import { clearSessionQueues } from "../../../auto-reply/reply/queue/cleanup.js";
import { initSessionState } from "../../../auto-reply/reply/session.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionMutationHandlers } from "../../../gateway/server-methods/sessions-mutations.js";
import { registerInternalHook, unregisterInternalHook } from "../../../hooks/internal-hooks.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { beginSessionEffect } from "../../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import { killAllControlledSubagentRuns, killSessionSubagentRuns } from "./subagent-control-kill.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { registerSubagentRun } from "./subagent-registry.js";
import {
  writeChildSession,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentDisplayStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
beforeEach(async () => captureRuntimeConfigAsyncReader()());
const parentKey = "agent:main:main";
const controllerKey = "agent:main:telegram:default:direct:123";
const childKey = (id: string) => "agent:main:subagent:" + id;

const writeSession = (sessionKey: string, defaultSessionId: string, lifecycleRevision?: string) =>
  writeChildSession(fixture.stateDir, sessionKey, defaultSessionId, lifecycleRevision);
const displayStatus = (id: string) => resolveSubagentDisplayStatus(subagentRuns.get(id)!);

function sessions(storePath: string) {
  return {
    read: (sessionKey: string) => loadSessionEntry({ storePath, sessionKey }),
    transcript: (sessionId: string) => loadTranscriptEvents({ storePath, sessionId }),
    patch: (
      sessionKey: string,
      fields: Partial<NonNullable<ReturnType<typeof loadSessionEntry>>>,
    ) => patchSessionEntryCore({ storePath, sessionKey }, (entry) => ({ ...entry, ...fields })),
  };
}

function expectResetResponse(respond: ReturnType<typeof vi.fn>, ok: boolean) {
  expect(respond).toHaveBeenCalledWith(
    ok,
    ok ? expect.objectContaining({ ok: true }) : undefined,
    ok
      ? undefined
      : expect.objectContaining({ message: expect.stringContaining("Reset did not complete") }),
  );
}

function resetRpc(
  respond: Parameters<
    NonNullable<(typeof sessionMutationHandlers)["sessions.reset"]>
  >[0]["respond"],
) {
  return sessionMutationHandlers["sessions.reset"]!({
    params: { key: parentKey },
    context: createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
    }) as never,
    respond,
    client: { connect: { scopes: ["operator.admin"] } } as never,
    req: { type: "req", id: "reset", method: "sessions.reset" },
    isWebchatConnect: () => false,
  });
}

function resetChat() {
  return initSessionState({
    ctx: finalizeInboundContext({
      Body: "/reset",
      From: "telegram:123",
      To: "telegram:123",
      ChatType: "direct",
      SessionKey: parentKey,
      Provider: "telegram",
    }),
    cfg: getRuntimeConfig(),
    commandAuthorized: true,
  });
}

function registerChild(
  runId: string,
  sessionEntry: Parameters<typeof registerSubagentRun>[0]["sessionEntry"],
  overrides: Partial<Parameters<typeof registerSubagentRun>[0]> = {},
) {
  return registerSubagentRun({
    runId,
    childSessionKey: childKey(runId),
    childAgentId: "main",
    sessionEntry,
    requesterSessionKey: parentKey,
    controllerSessionKey: controllerKey,
    requesterAgentId: "main",
    requesterDisplayKey: parentKey,
    task: runId,
    cleanup: "keep",
    expectsCompletionMessage: true,
    ...overrides,
  });
}

it.each([false, true])(
  "reset preserves a replacement child and retires only suppressed terminal work (suppressed=%s)",
  async (suppressed) => {
    const storePath = await writeSession(parentKey, "reset-parent", "reset-parent-revision");
    const { read, patch } = sessions(storePath);
    const key = childKey("replaced");
    await writeSession(key, "original-child", "original-revision");
    await registerChild("original-run", read(key), {
      childSessionKey: key,
      controllerSessionKey: undefined,
      task: "old retained assignment",
      expectsCompletionMessage: false,
    });
    await updateRun("original-run", (entry) => {
      entry.execution = {
        status: "terminal",
        endedAt: 1_000,
        outcome: { status: "error", error: "original session incarnation changed" },
        suppressSessionEffects: suppressed ? true : undefined,
      };
      entry.completion = { required: false, capturedAt: 1_000, resultText: "stopped" };
      entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
    });
    await patch(key, { sessionId: "replacement-child", lifecycleRevision: "replacement-revision" });
    const replacement = read(key);
    const interruptReplacement = vi.fn();
    const replacementAdmission = await beginSessionEffect({
      scope: storePath,
      identities: [key, "replacement-child"],
      assertAllowed: () => {},
      onInterrupt: interruptReplacement,
    });
    const respond = vi.fn();
    try {
      await resetRpc(respond);
      expectResetResponse(respond, suppressed);
      const parent = read(parentKey);
      if (suppressed) {
        expect(parent?.lifecycleRevision).not.toBe("reset-parent-revision");
        expect(subagentRuns.get("original-run")).toMatchObject({
          execution: {
            outcome: { status: "error", error: "original session incarnation changed" },
          },
          suppressCompletionDelivery: true,
        });
        expect(subagentRuns.get("original-run")?.requesterSettleWake).toBeUndefined();
      } else {
        expect(parent?.lifecycleRevision).toBe("reset-parent-revision");
        expect(subagentRuns.get("original-run")?.requesterSettleWake).toBeDefined();
      }
      expect(read(key)).toEqual(replacement);
      expect(interruptReplacement).not.toHaveBeenCalled();
    } finally {
      replacementAdmission.release();
    }
  },
);

async function updateRun(runId: string, update: (draft: SubagentRunRecord) => void): Promise<void> {
  await mutateSubagentRuns([runId], (rows) => {
    const current = rows.get(runId);
    if (!current) {
      throw new Error("Reset fixture run missing");
    }
    const draft = structuredClone(current);
    update(draft);
    return { value: undefined, postimages: new Map([[runId, draft]]) };
  });
}

function expectUnfinishedYieldedRun(runId: string) {
  const entry = subagentRuns.get(runId);
  expect(displayStatus(runId), runId).toBe("waiting for external continuation");
  expect(entry, runId).toMatchObject({
    pauseReason: "sessions_yield",
    execution: { status: "terminal" },
  });
  expect(entry?.endedReason, runId).toBeUndefined();
  expect(entry?.execution.outcome, runId).toBeUndefined();
  expect(entry?.completion?.capturedAt, runId).toBeUndefined();
}

const pauseRun = (id: string) =>
  updateRun(id, (entry) => {
    expect(markSubagentRunPausedAfterYield({ entry })).toBe(true);
  });

it.each(
  (["chat", "rpc"] as const).flatMap((boundary) =>
    [false, true].map((failed) => ({ boundary, failed })),
  ),
)(
  "$boundary reset accounts for requester/controller-owned children (failed=$failed)",
  async ({ boundary, failed }) => {
    fixture.announce.mockResolvedValue("delivered");
    const storePath = await writeSession(parentKey, "reset-parent-session");
    const { read, transcript } = sessions(storePath);
    await appendTranscriptMessage(
      { storePath, sessionKey: parentKey, sessionId: "reset-parent-session" },
      { message: { role: "user", content: "conversation before reset" } },
    );
    const previousTranscript = await transcript("reset-parent-session");
    const childTranscripts = new Map<string, Awaited<ReturnType<typeof loadTranscriptEvents>>>();
    for (const [id, requesterSessionKey, controllerSessionKey] of [
      ["requester-child", parentKey, controllerKey],
      ["controller-child", "agent:main:other-requester", parentKey],
      ["queued-child", parentKey, controllerKey],
      ["unrelated-child", "agent:main:other-requester", controllerKey],
    ] as const) {
      await writeSession(childKey(id), id);
      await appendTranscriptMessage(
        { storePath, sessionKey: childKey(id), sessionId: id },
        { message: { role: "user", content: "child conversation " + id } },
      );
      childTranscripts.set(id, await transcript(id));
      await registerChild(id, read(childKey(id)), {
        requesterSessionKey,
        controllerSessionKey,
        requesterDisplayKey: requesterSessionKey,
      });
      await updateRun(id, (entry) => {
        if (id === "queued-child") {
          entry.execution = { status: "queued" };
        } else {
          expect(markSubagentRunPausedAfterYield({ entry })).toBe(true);
        }
      });
    }
    const previousRevision = read(parentKey)?.lifecycleRevision;
    if (failed) {
      probe.command(
        stateWorker,
        async (command, options, scope) => {
          if (
            isSubagentRegistryWriteCommand(command) &&
            command.input.values.some(
              (row) =>
                row.run_id === "requester-child" && row.payload_json?.includes('"killIntent":{'),
            )
          ) {
            throw new Error("termination persistence refused");
          }
          return scope.execute(command, options);
        },
        { original: runSubagentStateWorkerOperation },
      );
    }
    if (boundary === "chat") {
      const reset = resetChat();
      if (failed) {
        await expect(reset).rejects.toThrow("Reset did not complete");
      } else {
        expect((await reset).resetTriggered).toBe(true);
      }
    } else {
      const respond = vi.fn();
      await resetRpc(respond);
      expectResetResponse(respond, !failed);
    }
    for (const id of ["requester-child", "controller-child", "queued-child"]) {
      expect
        .soft(displayStatus(id), id)
        .toBe(failed && id === "requester-child" ? "waiting for external continuation" : "killed");
      if (failed && id === "requester-child") {
        expectUnfinishedYieldedRun(id);
      }
      expect(read(childKey(id))?.sessionId).toBe(id);
    }
    expectUnfinishedYieldedRun("unrelated-child");
    for (const [sessionId, previous] of childTranscripts) {
      expect(await transcript(sessionId)).toEqual(previous);
    }
    if (failed) {
      expect(await transcript("reset-parent-session")).toEqual(previousTranscript);
      expect(read(parentKey)?.lifecycleRevision).toBe(previousRevision);
    }
  },
);

// src/auto-reply/reply/session.test.ts owns parent identity rebind in
// "reacquires a changed identity before an explicit reset".
it.each(["chat", "rpc"] as const)(
  "%s reset drains parent then child admissions before committing the boundary",
  async (boundary) => {
    const storePath = await writeSession(parentKey, "parent", "before-reset");
    const { read, patch } = sessions(storePath);
    await writeSession(childKey("draining"), "draining");
    await registerChild("draining", read(childKey("draining")));
    const parentInterrupted = createDeferredCore();
    const childInterrupted = createDeferredCore();
    const interruptChild = vi.fn(() => childInterrupted.resolve());
    const parentAdmission = await beginSessionEffect({
      scope: storePath,
      identities: [parentKey, "parent"],
      assertAllowed: () => {},
      onInterrupt: () => parentInterrupted.resolve(),
    });
    const childAdmission = await beginSessionEffect({
      scope: storePath,
      identities: [childKey("draining"), "draining"],
      run: {
        runId: "draining",
        sessionKey: childKey("draining"),
        sessionId: "draining",
        agentId: "main",
      },
      assertAllowed: () => {},
      onInterrupt: interruptChild,
    });
    const respond = vi.fn();
    const reset = boundary !== "rpc" ? resetChat() : resetRpc(respond);
    try {
      await parentInterrupted.promise;
      expect(interruptChild).not.toHaveBeenCalled();
      expect(subagentRuns.get("draining")?.killIntent).toBeUndefined();
      parentAdmission.release();
      await childInterrupted.promise;
      expect(read(parentKey)?.lifecycleRevision).toBe("before-reset");
      // A child finalizer writes through the same store lane before releasing.
      // Running cleanup inside that lane would deadlock this real write.
      await patch(childKey("draining"), { displayName: "finalized before reset" });
      childAdmission.release();
      await reset;
      if (boundary === "rpc") {
        expectResetResponse(respond, true);
      }
      expect(displayStatus("draining")).toBe("killed");
      expect(read(parentKey)?.lifecycleRevision).not.toBe("before-reset");
      expect(read(childKey("draining"))).toMatchObject({
        sessionId: "draining",
        displayName: "finalized before reset",
      });
    } finally {
      parentAdmission.release();
      childAdmission.release();
      await reset;
    }
  },
);

it("lifecycle requester cleanup respects agent ownership without granting ordinary controller authority", async () => {
  const cfg = getRuntimeConfig();
  for (const agentId of ["main", "work"]) {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId,
      sessionKey: "agent:" + agentId + ":subagent:global-child",
      defaultSessionId: agentId,
    });
    await registerChild(
      agentId,
      { sessionId: agentId },
      {
        childSessionKey: "agent:" + agentId + ":subagent:global-child",
        childAgentId: agentId,
        requesterSessionKey: "global",
        controllerSessionKey: "agent:" + agentId + ":other-controller",
        requesterAgentId: agentId,
        requesterDisplayKey: "global",
      },
    );
    await pauseRun(agentId);
  }
  const ordinary = await killAllControlledSubagentRuns({
    cfg,
    controller: {
      controllerSessionKey: "global",
      controllerAgentId: "main",
      callerSessionKey: "global",
      callerIsSubagent: false,
      controlScope: "children",
    },
    runs: [...subagentRuns.values()],
  });
  expect(ordinary).toMatchObject({ status: "ok", killed: 0 });
  expectUnfinishedYieldedRun("main");
  expect(
    await killSessionSubagentRuns({ cfg, sessionKey: "global", agentId: "main" }),
  ).toMatchObject({ status: "ok", killed: 1 });
  expect(displayStatus("main")).toBe("killed");
  expectUnfinishedYieldedRun("work");
});

it.each(["sessionId", "lifecycleRevision"] as const)(
  "RPC reset preserves runtime and children of a replacement parent after a hook changes %s",
  async (field) => {
    const storePath = await writeSession(parentKey, "parent", "original");
    const { read, patch } = sessions(storePath);
    const replaceParent = async () => {
      await patch(parentKey, { [field]: "replacement" });
      enqueueFollowupRun(
        parentKey,
        createQueueTestRun({ prompt: "replacement follow-up" }),
        { mode: "followup" },
        "none",
        undefined,
        false,
      );
      await writeSession(childKey("replacement-child"), "replacement-child");
      await registerChild(
        "replacement-child",
        { sessionId: "replacement-child" },
        {
          requesterSessionKey: "agent:main:other-requester",
          controllerSessionKey: parentKey,
          requesterDisplayKey: "other requester",
          task: "replacement work",
        },
      );
      await pauseRun("replacement-child");
    };
    registerInternalHook("command:reset", replaceParent);
    const respond = vi.fn();
    try {
      await resetRpc(respond);
      expectUnfinishedYieldedRun("replacement-child");
      expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(read(parentKey)?.[field]).toBe("replacement");
      expect(getFollowupQueueDepth(parentKey)).toBe(1);
    } finally {
      clearSessionQueues([parentKey]);
      unregisterInternalHook("command:reset", replaceParent);
    }
  },
);
