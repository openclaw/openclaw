import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { waitForCapturedSessionNativeAttemptEnd } from "../sessions/session-controller.native-runtime.js";
import { readSessionControllerOperationState } from "../sessions/session-controller.state.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { getEmbeddedRunAttachment } from "./embedded-agent-runner/run-state.js";
import { claimAgentSessionWriter } from "./embedded-agent-runner/run/session-bootstrap.js";
import {
  abortAndDrainEmbeddedAgentRun,
  detachActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
} from "./embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
  testing,
} from "./embedded-agent-runner/runs.test-support.js";
import { resolveAgentRunSessionTarget } from "./run-session-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {}, authorize() {} };
const readAuthority = { assertCurrent() {}, assertReadable() {} };
let stateDir: string;
let actor: ReturnType<typeof memorySessionActorOwners.get>;
let sibling: typeof actor;
const bindings = new Map<string, SessionActorStorageBinding>();
let sql: ReturnType<typeof observeHostDataSql>;
function withMemory<T>(target: { storePath: string; sessionKey: string }, operation: () => T): T {
  const binding = bindings.get(`${target.storePath}\n${target.sessionKey}`);
  if (!binding) {
    throw new Error("Missing test memory binding");
  }
  return runWithSessionActorStorage(binding, operation);
}
beforeEach(() => {
  sql = observeHostDataSql();
});
const memoryPath = (root: string) =>
  resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: { OPENCLAW_STATE_DIR: root } });
beforeAll(() => {
  stateDir = tempDirs.make("runtime-recovery-incognito-");
  const owner = (root: string) =>
    memorySessionActorOwners.get({ agentId: "main", path: memoryPath(root) });
  actor = owner(stateDir);
  sibling = owner(tempDirs.make("runtime-recovery-other-root-"));
});
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  clearRuntimeConfigSnapshot();
  try {
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});
afterAll(async () => {
  for (const binding of bindings.values()) {
    await binding.actor.release();
  }
  memorySessionActorOwners.closeDatabase(sibling);
  memorySessionActorOwners.closeDatabase(actor);
});

async function create(name: string, patch: Partial<SessionEntry> = {}, owner = actor) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const entry: SessionEntry = {
    sessionId: name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lifecycleRevision: "initial",
    incognito: true,
    ...patch,
  };
  const handle = await owner.acquire({ database: owner.identity, sessionKey }, readAuthority);
  bindings.set(`${owner.path}\n${sessionKey}`, {
    actor: handle,
    authority,
    agentId: owner.agentId,
    path: owner.path,
  });
  await writeEntry(handle, entry);
  return { agentId: "main", sessionKey, sessionId: entry.sessionId, storePath: owner.path };
}

async function writeEntry(handle: SessionActorStorageBinding["actor"], entry: SessionEntry) {
  expect(
    await handle.storage!.mutate({ type: "session.entry.create", input: { entry } }, authority),
  ).toMatchObject({ kind: "committed" });
}

type Target = Awaited<ReturnType<typeof create>>;
const configFor = (root = stateDir) => ({ session: { store: path.join(root, "sessions.json") } });
const readEntry = (target: Target) => actor.readSession(target.sessionKey, authority)?.entry;
async function registerRun(target: Target, runId: string, abort: () => void) {
  const handle = createEmbeddedRunHandle({ runId, abort });
  const operation = registerTestEmbeddedRun(
    target.sessionId,
    handle,
    target.sessionKey,
    undefined,
    "main",
    undefined,
    undefined,
    { storeScope: target.storePath },
  );
  const writer = await withMemory(target, () =>
    claimAgentSessionWriter({
      ...target,
      sessionTarget: target,
      runId,
      replyOperation: operation,
      prompt: "incognito cleanup",
      workspaceDir: stateDir,
      timeoutMs: 30_000,
    }),
  );
  const state = readSessionControllerOperationState(operation);
  if (!writer || !state) {
    throw new Error("Missing admitted incognito writer");
  }
  const releaseFence = state.registerTerminalProducerFence((isCurrent, options) =>
    writer.revoke(isCurrent, options),
  );
  onTestFinished(() => {
    releaseFence();
    detachActiveEmbeddedRun(target.sessionId, handle, target.sessionKey);
    operation.complete();
  });
  return { operation, handle };
}

it("resolves partial markers and store/SID targets within the selected physical actor", async () => {
  const config = configFor();
  const target = await create("partial-target");
  await create("different-key", { sessionId: target.sessionId }, sibling);
  await withMemory(target, async () => {
    const resolve = (partial: Partial<Parameters<typeof resolveAgentRunSessionTarget>[0]>) =>
      resolveAgentRunSessionTarget({
        config,
        sessionId: target.sessionId,
        missingSessionKey: "resolve-existing",
        ...partial,
      });
    for (const partial of [
      { sessionFile: formatSqliteSessionFileMarker(target) },
      { sessionTarget: { agentId: "main", storePath: actor.path, sessionId: target.sessionId } },
    ]) {
      await expect(resolve(partial)).resolves.toMatchObject(target);
    }
    await expect(
      resolve({
        sessionFile: formatSqliteSessionFileMarker({ ...target, storePath: sibling.path }),
      }),
    ).rejects.toThrow("Session storage owner belongs to another state root");
  });
});

it("keeps selected absence missing without discovering a durable or successor owner", async () => {
  const absentRoot = tempDirs.make("runtime-recovery-absent-");
  const storePath = memoryPath(absentRoot);
  await expect(
    resolveAgentRunSessionTarget({
      config: configFor(absentRoot),
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "missing",
        storePath,
      }),
      sessionId: "missing",
      missingSessionKey: "resolve-existing",
    }),
  ).rejects.toThrow("Cannot resolve a session key");
  expect(memorySessionActorOwners.read({ agentId: "main", path: storePath })).toBeUndefined();
});

it.each(["settle", "replacement", "incarnation"] as const)(
  "fences the incognito writer and honors %s before terminal persistence",
  async (outcome) => {
    const target = await create(`cancel-snapshot-${outcome}`, {
      lifecycleRunId: "cancel-run",
      startedAt: 9_000,
    });
    setRuntimeConfigSnapshot(configFor());
    const aborted = vi.fn();
    const native = await registerRun(target, "cancel-run", aborted);
    const other = await create(
      `same-id-other-owner-${outcome}`,
      { sessionId: target.sessionId },
      sibling,
    );
    const otherBefore = { ...sibling.readSession(other.sessionKey, authority)?.entry };
    let rawSettled = false;
    const rawSettlement = waitForCapturedSessionNativeAttemptEnd(
      target.sessionId,
      null,
      getEmbeddedRunAttachment(native.handle),
    ).then(() => {
      rawSettled = true;
    });
    const replacementAbort = vi.fn();
    let replacementEntry: SessionEntry | undefined;
    const storage = bindings.get(`${target.storePath}\n${target.sessionKey}`)?.actor.storage;
    if (!storage) {
      throw new Error("Missing incognito storage factory");
    }
    const acquire = storage.acquire.bind(storage);
    const preparation = vi.spyOn(storage, "acquire").mockImplementationOnce(async (...args) => {
      expect(aborted).toHaveBeenCalledOnce();
      if (outcome === "replacement") {
        await registerRun(target, "replacement-run", replacementAbort);
        await withMemory(target, () =>
          patchSessionEntryCore(target, () => ({ lifecycleRunId: "replacement-run" })),
        );
        replacementEntry = { ...readEntry(target)! };
      } else if (outcome === "incarnation") {
        await withMemory(target, () =>
          patchSessionEntryCore(target, () => ({
            sessionId: "successor-incarnation",
            lifecycleRevision: "successor-revision",
            lifecycleRunId: "successor-run",
            activeWriterRunId: "successor-run",
          })),
        );
        replacementEntry = { ...readEntry(target)! };
      }
      return acquire(...args);
    });
    onTestFinished(() => preparation.mockRestore());
    await expect(
      withMemory(target, () =>
        abortAndDrainEmbeddedAgentRun({
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          forceClear: true,
          settleMs: 0,
        }),
      ),
    ).resolves.toMatchObject({ aborted: true, drained: false, forceCleared: outcome === "settle" });
    expect(aborted).toHaveBeenCalledOnce();
    const entry = readEntry(target);
    expect(isEmbeddedAgentRunHandleActive(target.sessionId)).toBe(outcome !== "settle");
    expect(rawSettled).toBe(false);
    expect(sibling.readSession(other.sessionKey, authority)?.entry).toEqual(otherBefore);
    if (outcome !== "settle") {
      expect(entry).toEqual(replacementEntry);
      expect([entry?.status, entry?.abortedLastRun]).toEqual([undefined, undefined]);
      expect(replacementAbort).not.toHaveBeenCalled();
    } else {
      expect(entry).toMatchObject({
        sessionId: target.sessionId,
        status: "killed",
        abortedLastRun: true,
      });
      expect(entry?.activeWriterRunId).toBeUndefined();
    }
    detachActiveEmbeddedRun(target.sessionId, native.handle, target.sessionKey);
    await rawSettlement;
  },
);
