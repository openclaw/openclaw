import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { isRecordedModelFallbackStop } from "../model-fallback-stop.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { SessionManager } from "./session-manager.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "async-message-worker" });
});
afterAll(async () => {
  await state.cleanup();
});

async function fixture(testState: OpenClawTestState, name: string) {
  const target = {
    agentId: "main",
    sessionId: name,
    sessionKey: `agent:main:${name}`,
    storePath: path.join(testState.agentDir("main"), "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: name, updatedAt: 1 });
  const manager = await SessionManager.openAsync(target, testState.workspaceDir);
  return { target, manager };
}

const user = (key: string) => ({
  role: "user" as const,
  content: `Synthetic input ${key}`,
  timestamp: 1,
  idempotencyKey: `${key}:user`,
});

it("commits user and custom messages in FIFO order without host writes, and checks only fresh messages", async () => {
  const { target, manager } = await fixture(state, "async-messages");
  const database = openOpenClawAgentDatabase({ agentId: target.agentId, path: target.storePath });
  const hostExec = vi.spyOn(database.db, "exec");
  const beforeFreshMessageCommit = vi.fn(() => {
    expect(database.db.isTransaction).toBe(false);
  });
  try {
    const first = await manager.appendMessageWithTranscriptAnchorAsync(user("first"), {
      beforeFreshMessageCommit,
    });
    expect(first).toMatchObject({ appended: true, anchor: { entryId: first.entryId } });
    const replay = await manager.appendMessageWithTranscriptAnchorAsync(
      { ...user("first"), timestamp: 999 },
      { beforeFreshMessageCommit },
    );
    expect(replay).toMatchObject({
      appended: false,
      entryId: first.entryId,
      message: first.message,
    });
    expect(beforeFreshMessageCommit).toHaveBeenCalledTimes(1);
    const before = manager.getPersistedEntries();
    await expect(
      manager.appendMessageAsync(user("refused"), {
        beforeFreshMessageCommit: () => {
          throw new Error("Fresh message owner ended");
        },
      }),
    ).rejects.toThrow("Fresh message owner ended");
    expect(manager.getPersistedEntries()).toEqual(before);

    const custom = {
      role: "custom" as const,
      customType: "synthetic-notice",
      content: "Synthetic custom message",
      display: true,
      timestamp: 2,
    };
    const [customId, lastId] = await Promise.all([
      manager.appendMessageAsync(custom, { beforeFreshMessageCommit }),
      manager.appendMessageAsync(user("last"), { beforeFreshMessageCommit }),
    ]);
    expect(manager.getEntries()).toMatchObject([
      { id: first.entryId, parentId: null, message: user("first") },
      { id: customId, parentId: first.entryId, message: custom },
      { id: lastId, parentId: customId, message: user("last") },
    ]);
    expect(manager.getLeafId()).toBe(lastId);
    expect(beforeFreshMessageCommit).toHaveBeenCalledTimes(3);
    const beforeRejectedReplay = manager.getPersistedEntries();
    const refusedReplay = await manager.appendMessageAsync(user("first")).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusedReplay).toMatchObject({
      name: "Error",
      message: `Session transcript keyed user is outside the current turn: ${first.entryId}`,
    });
    expect(isRecordedModelFallbackStop(refusedReplay)).toBe(false);
    expect(manager.getPersistedEntries()).toEqual(beforeRejectedReplay);
    const afterRefusal = await manager.appendMessageAsync(user("after-replay-refusal"));
    expect(manager.getLeafEntry()).toMatchObject({ id: afterRefusal, parentId: lastId });
    expect(hostExec.mock.calls.filter(([sql]) => /^BEGIN\b/iu.test(sql))).toEqual([]);
    expect(await loadTranscriptEvents(target)).toEqual(manager.getPersistedEntries());
  } finally {
    hostExec.mockRestore();
  }
});

it("revalidates overtaken keyed replays while retaining fresh committed pending users", async () => {
  const { target, manager } = await fixture(state, "overtaken-keyed-replay");
  const originalId = await manager.appendMessageAsync(user("original"));
  let newerId: string | undefined;
  const appendOvertaken = async (
    message: Parameters<SessionManager["appendMessageWithTranscriptAnchorAsync"]>[0],
    nextKey: string,
  ) => {
    const withWorker = metadataRuntime.withSessionMetadataWorker;
    const delayed: typeof withWorker = async (
      options,
      database,
      assertCurrent,
      operation,
      controls,
    ) => {
      const receipt = await withWorker(options, database, assertCurrent, operation, controls);
      // The retained synchronous SDK can publish before an awaited receipt is adopted.
      newerId = manager.appendMessage(user(nextKey));
      return receipt;
    };
    const spy = vi.spyOn(metadataRuntime, "withSessionMetadataWorker").mockImplementation(delayed);
    try {
      return await manager.appendMessageWithTranscriptAnchorAsync(message);
    } finally {
      spy.mockRestore();
    }
  };
  const replayFailure = await appendOvertaken(user("original"), "after-replay").then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(replayFailure).toMatchObject({
    name: "Error",
    message: `Session transcript keyed user is outside the current turn: ${originalId}`,
  });
  expect(isRecordedModelFallbackStop(replayFailure)).toBe(false);
  expect(manager.getEntries()).toMatchObject([
    { id: originalId, parentId: null },
    { id: newerId, parentId: originalId },
  ]);
  expect(manager.getLeafId()).toBe(newerId);

  const pending = expectDefined(
    await stageSessionPendingInput(target, {
      runId: "fresh-pending",
      message: user("fresh-pending"),
      assertCurrent: () => {},
    }),
    "Expected fresh pending custody",
  );
  try {
    const committed = await pending.run(() => appendOvertaken(pending.message, "after-fresh"));
    expect(committed).toMatchObject({
      entryId: pending.inputId,
      message: pending.message,
      appended: true,
      viewWasSuperseded: true,
    });
    expect(pending.state).toBe("consumed");
    expect(manager.getLeafEntry()).toMatchObject({ id: newerId, parentId: pending.inputId });
    expect(await loadTranscriptEvents(target)).toEqual(manager.getPersistedEntries());
  } finally {
    pending.finish("interrupted");
  }
});

it("fences local navigation changes at worker commit and receipt publication", async () => {
  const { target, manager } = await fixture(state, "navigation-during-append");
  const seed = expectDefined(
    await manager.appendMessageAsync(user("navigation-seed")),
    "Expected seed",
  );
  const tail = expectDefined(
    await manager.appendMessageAsync(user("navigation-tail")),
    "Expected tail",
  );
  const before = await loadTranscriptEvents(target);
  for (const change of ["branch", "branch-back"] as const) {
    manager.branch(tail);
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const admission = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            manager.branch(seed);
            if (change === "branch-back") {
              manager.branch(tail);
            }
          }
          admit(request, grant);
        }, attachment),
      );
    try {
      await expect(manager.appendMessageAsync(user(`refused-${change}`))).rejects.toThrow(
        "Session transcript navigation changed before publication",
      );
      expect(manager.getLeafId()).toBe(change === "branch" ? seed : tail);
      expect(await loadTranscriptEvents(target)).toEqual(before);
    } finally {
      admission.mockRestore();
    }
  }

  const withWorker = metadataRuntime.withSessionMetadataWorker;
  const delayed: typeof withWorker = async (
    options,
    database,
    assertCurrent,
    operation,
    controls,
  ) => {
    const receipt = await withWorker(options, database, assertCurrent, operation, controls);
    manager.resetLeaf();
    return receipt;
  };
  const publication = vi
    .spyOn(metadataRuntime, "withSessionMetadataWorker")
    .mockImplementation(delayed);
  let failure: unknown;
  try {
    failure = await manager.appendMessageAsync(user("committed-before-reset")).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: "SessionMessageCommittedError",
      cause: { message: "Session transcript navigation changed before publication" },
    });
    expect(isRecordedModelFallbackStop(failure)).toBe(true);
    expect(() => manager.getEntries()).toThrow("Session entry committed");
  } finally {
    publication.mockRestore();
  }
  const persisted = await loadTranscriptEvents(target);
  expect(persisted.slice(0, before.length)).toEqual(before);
  expect(persisted.slice(before.length)).toMatchObject([
    { type: "message", parentId: tail, message: user("committed-before-reset") },
  ]);
});

it.each([false, true])(
  "preserves pending custody and closed committed replay (collected: %s)",
  async (collected) => {
    const { target, manager } = await fixture(state, `pending-messages-${collected}`);
    const stage = async (key: string) =>
      expectDefined(
        await stageSessionPendingInput(target, {
          runId: key,
          message: user(key),
          assertCurrent: () => {},
        }),
        "Expected pending input custody",
      );
    const firstSource = await stage("first");
    const sources = [firstSource];
    if (collected) {
      sources.push(await stage("second"));
    }
    const receipt = collected
      ? expectDefined(
          bindSessionPendingInputSources(sources, user("aggregate")),
          "Expected aggregate custody",
        )
      : firstSource;
    const beforeFreshMessageCommit = vi.fn(() => {
      throw new Error("Accepted input must retain its original admission");
    });
    try {
      await expect(manager.appendMessageAsync(firstSource.message)).rejects.toThrow(
        "admitted turn",
      );
      const committed = await receipt.run(() =>
        manager.appendMessageWithTranscriptAnchorAsync(receipt.message, {
          beforeFreshMessageCommit,
        }),
      );
      expect(committed).toMatchObject({
        entryId: receipt.inputId,
        message: receipt.message,
        appended: true,
      });
      expect([receipt.state, ...sources.map((source) => source.state)]).toEqual(
        Array(sources.length + 1).fill("consumed"),
      );
      expect(beforeFreshMessageCommit).not.toHaveBeenCalled();
      const events = await loadTranscriptEvents(target);
      expect(events).toEqual(manager.getPersistedEntries());
      receipt.finish("cancelled");
      await expect(
        withSessionPendingInputPersistence(receipt, () =>
          manager.appendMessageWithTranscriptAnchorAsync(receipt.message, {
            beforeFreshMessageCommit,
          }),
        ),
      ).resolves.toMatchObject({ entryId: receipt.inputId, appended: false });
      expect(beforeFreshMessageCommit).not.toHaveBeenCalled();
      expect(await loadTranscriptEvents(target)).toEqual(events);
    } finally {
      receipt.finish("interrupted");
      for (const source of sources) {
        source.finish("interrupted");
      }
    }
  },
);

it("rolls back worker promotion when pending authority retires at commit", async () => {
  const { target, manager } = await fixture(state, "revoked-message");
  await manager.appendMessageAsync(user("seed"));
  let current = true;
  const receipt = expectDefined(
    await stageSessionPendingInput(target, {
      runId: "revoked",
      message: user("revoked"),
      assertCurrent: () => {
        if (!current) {
          throw new Error("Pending owner retired at commit");
        }
      },
    }),
    "Expected pending input custody",
  );
  const before = await loadTranscriptEvents(target);
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const admission = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          current = false;
        }
        admit(request, grant);
      }, attachment),
    );
  try {
    await expect(receipt.run(() => manager.appendMessageAsync(receipt.message))).rejects.toThrow(
      "Pending owner retired at commit",
    );
    expect(receipt.state).toBe("queued");
    expect(manager.getPersistedEntries()).toEqual(before);
  } finally {
    admission.mockRestore();
    current = true;
    receipt.finish("interrupted");
  }
  expect(await loadTranscriptEvents(target)).toEqual(before);
});
