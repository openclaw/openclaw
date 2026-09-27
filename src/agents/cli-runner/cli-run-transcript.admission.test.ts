import { beforeEach, expect, it, vi } from "vitest";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptWriterFence } from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionManager } from "../sessions/session-manager.js";
import { persistCliRunBlock } from "./cli-run-transcript.js";
import type { RunCliAgentParams } from "./types.js";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  flush: vi.fn(),
  open: vi.fn(),
  getTarget: vi.fn<() => SessionTranscriptRuntimeTarget | undefined>(),
  admit: vi.fn<(write: () => void) => Promise<void>>(),
  databaseWrite: vi.fn(),
  owned: vi.fn(),
  fence: vi.fn<() => SessionTranscriptWriterFence | undefined>(),
  writer: vi.fn(),
  patch: vi.fn(),
  read: vi.fn(),
  cloneEnv: vi.fn(),
  restore: vi.fn(),
  restoreCommit: vi.fn(),
  resolvePath: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../config/config-env-vars.js", () => ({
  cloneEnvWithPlatformSemantics: () => mocks.cloneEnv(),
}));
vi.mock("../../config/sessions/paths.js", () => ({ resolveSessionStorePathCore: vi.fn() }));
vi.mock("../../config/sessions/cli-history-boundary.js", () => ({
  getCliHistoryWriter: () => ({ assertCurrent: mocks.writer }),
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadExactSessionEntryCandidates: mocks.read,
  patchSessionEntryCore: mocks.patch,
  resolveSessionEntrySelection: () => ({ normalizedKey: "agent:logical:block" }),
  resolveSessionTranscriptDatabasePath: mocks.resolvePath,
}));
vi.mock("../../config/sessions/session-store-owner.js", () => ({
  resolvePersistedSessionStoreOwnerForTarget: () => ({ kind: "none" }),
}));
vi.mock("../../config/sessions/transcript.js", () => ({
  appendExactAssistantMessageToSessionTranscript: vi.fn(),
}));
vi.mock("../../config/sessions/transcript-write-context.js", () => ({
  captureOwnedTranscriptWriteAssertion: () => mocks.owned,
  getOwnedSessionTranscriptWriterFence: mocks.fence,
  SessionTranscriptWriterClaimReboundError: class extends Error {},
}));
vi.mock("../../config/sessions/session-cold-storage.js", () => ({
  restoreSessionColdTranscript: mocks.restore,
}));
vi.mock("../../config/state-dir.js", () => ({ resolveStateDir: () => "/synthetic/state" }));
vi.mock("../../context-engine/host-compat.js", () => ({
  buildGenericCliContextEngineHostSupport: vi.fn(),
}));
vi.mock("../../infra/errors.js", () => ({ formatErrorMessage: String }));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));
vi.mock("../../routing/session-key.js", () => ({
  parseAgentSessionKey: () => ({ agentId: "logical" }),
}));
vi.mock("../../state/openclaw-agent-db-write.js", () => ({
  withOpenClawAgentDatabaseWrite: (
    options: { agentId: string; path?: string },
    write: () => void,
  ) => mocks.databaseWrite({ agentId: options.agentId, path: options.path }, write),
}));
vi.mock("../agent-scope.js", () => ({ resolveSessionAgentId: () => "logical" }));
vi.mock("../bootstrap-mode.js", () => ({ isHeartbeatLifecycleRunKind: vi.fn() }));
vi.mock("../harness/agent-end-side-effects.js", () => ({
  awaitAgentEndSideEffects: vi.fn(),
  runAgentEndSideEffects: vi.fn(),
}));
vi.mock("../harness/context-engine-lifecycle.js", () => ({
  finalizeHarnessContextEngineTurn: vi.fn(),
  runHarnessContextEngineMaintenance: vi.fn(),
}));
vi.mock("../harness/hook-helpers.js", () => ({ runAgentHarnessBeforeMessageWriteHook: vi.fn() }));
vi.mock("../stream-message-shared.js", () => ({
  buildAssistantMessage: vi.fn(),
  buildUsageWithNoCost: vi.fn(),
}));
vi.mock("../sessions/session-manager.js", () => ({
  SessionManager: {
    open: mocks.open,
    inMemory: () => ({
      getSessionTarget: mocks.getTarget,
      appendMessage: mocks.append,
      flushPendingPersistence: mocks.flush,
    }),
  },
}));
vi.mock("../sessions/session-manager-write-admission.js", () => ({
  withSessionManagerWrite: (
    manager: Pick<SessionManager, "getSessionTarget">,
    write: () => void,
  ) => (manager.getSessionTarget() ? mocks.admit(write) : Promise.resolve(write())),
}));

const target = {
  agentId: "logical",
  sessionKey: "agent:logical:block",
  sessionId: "original-session",
  storePath: "/synthetic/logical-store",
};
const source = { agentId: "physical-owner", path: "/synthetic/shared/openclaw-agent.sqlite" };
let current: InternalSessionEntry | undefined;
let currentSource = source;
let ambientSource = source;
let capturedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  vi.resetAllMocks();
  current = {
    sessionId: target.sessionId,
    updatedAt: 1,
    lifecycleRevision: "original-lifecycle",
    activeWriterRunId: "original-writer",
  };
  currentSource = source;
  ambientSource = source;
  capturedEnv = { OPENCLAW_STATE_DIR: "/synthetic/state" };
  mocks.cloneEnv.mockReturnValue(capturedEnv);
  mocks.restore.mockImplementation(async (_scope, assertCurrent?: () => void) => assertCurrent?.());
  mocks.getTarget.mockReturnValue(target);
  mocks.open.mockImplementation(() => SessionManager.inMemory());
  mocks.admit.mockImplementation(async (write) => write());
  mocks.databaseWrite.mockImplementation((_options, write: () => void) => mocks.admit(write));
  mocks.patch.mockImplementation(async () => ({ ...current }));
  mocks.resolvePath.mockReturnValue(source.path);
  mocks.read.mockImplementation(
    (scope: { env?: NodeJS.ProcessEnv; onReadSource?: (value: typeof source) => void }) => {
      scope.onReadSource?.(scope.env === capturedEnv ? currentSource : ambientSource);
      return current ? [{ sessionKey: target.sessionKey, entry: { ...current } }] : [];
    },
  );
});

function run(branch: "native" | "supplied") {
  const params: RunCliAgentParams = {
    ...target,
    sessionTarget: { ...target },
    ...(branch === "supplied" ? { sessionManager: SessionManager.inMemory() } : {}),
    sessionFile: "synthetic",
    workspaceDir: "/synthetic/workspace",
    prompt: "Private text",
    provider: "test-cli",
    timeoutMs: 1_000,
    runId: "blocked-run",
    onUserMessagePersisted: vi.fn(),
  };
  return {
    params,
    result: persistCliRunBlock(params, { message: "Policy block", pluginId: "fixture" }),
  };
}

function deferAdmission() {
  const queued = createDeferredCore();
  const released = createDeferredCore();
  let didQueue = false;
  mocks.admit.mockImplementation(async (write) => {
    didQueue = true;
    queued.resolve();
    await released.promise;
    write();
  });
  return {
    wait: async (result: Promise<void>) => {
      await Promise.race([queued.promise, result]);
      expect(didQueue).toBe(true);
    },
    release: () => released.resolve(),
  };
}

it.each(["native", "supplied"] as const)(
  "waits for %s admission before appending and flushing",
  async (branch) => {
    const admission = deferAdmission();
    const { params, result } = run(branch);
    try {
      await admission.wait(result);
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.flush).not.toHaveBeenCalled();
      expect(mocks.open).not.toHaveBeenCalled();
    } finally {
      admission.release();
      await result;
    }
    expect(mocks.append).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "Policy block" }],
      }),
    );
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.append.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.flush.mock.invocationCallOrder[0]!,
    );
    expect(params.onUserMessagePersisted).not.toHaveBeenCalled();
    if (branch === "native") {
      expect(mocks.databaseWrite).toHaveBeenCalledWith(
        expect.objectContaining(source),
        expect.any(Function),
      );
    }
  },
);

it.each(["missing", "session", "lifecycle", "writer", "store"] as const)(
  "refuses a %s native target after waiting",
  async (change) => {
    const admission = deferAdmission();
    const { result } = run("native");
    try {
      await admission.wait(result);
      if (change === "missing") {
        current = undefined;
      } else if (change === "session") {
        current!.sessionId = "successor-session";
      } else if (change === "lifecycle") {
        current!.lifecycleRevision = "successor-lifecycle";
      } else if (change === "writer") {
        current!.activeWriterRunId = "successor-writer";
      } else {
        currentSource = { ...source, path: "/synthetic/successor-store" };
      }
    } finally {
      admission.release();
      await result;
    }
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
  },
);

it.each(["native", "supplied"] as const)(
  "rechecks captured %s source and CLI writer after waiting",
  async (branch) => {
    for (const authority of [mocks.owned, mocks.writer]) {
      const admission = deferAdmission();
      const { result } = run(branch);
      try {
        await admission.wait(result);
        authority.mockImplementationOnce(() => {
          throw new Error("Retired source");
        });
      } finally {
        admission.release();
        await result;
      }
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.flush).not.toHaveBeenCalled();
    }
  },
);

it("leaves supplied initial-writer creation with the session manager", async () => {
  current = undefined;
  await run("supplied").result;
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.append).toHaveBeenCalledOnce();
  expect(mocks.flush).toHaveBeenCalledOnce();
});

it("keeps a supplied detached manager targetless", async () => {
  mocks.getTarget.mockReturnValue(undefined);
  await run("supplied").result;
  expect(mocks.admit).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.owned).not.toHaveBeenCalled();
  expect(mocks.writer).not.toHaveBeenCalled();
  expect(mocks.append).toHaveBeenCalledOnce();
});

it("keeps the native target captured before the caller changes its request", async () => {
  const admission = deferAdmission();
  const { params, result } = run("native");
  try {
    await admission.wait(result);
    params.sessionTarget = {
      ...target,
      sessionId: "successor-session",
      storePath: "/synthetic/successor",
    };
  } finally {
    admission.release();
    await result;
  }
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith({ ...target, env: capturedEnv });
  expect(mocks.append).toHaveBeenCalledOnce();
});

it.each(["missing", "retired", "store"] as const)(
  "refuses a %s native target before deferred cold restoration mutates it",
  async (change) => {
    const entered = createDeferredCore();
    const released = createDeferredCore();
    let didEnter = false;
    mocks.restore.mockImplementation(async (_scope, assertCurrent?: () => void) => {
      didEnter = true;
      entered.resolve();
      await released.promise;
      assertCurrent?.();
      mocks.restoreCommit();
    });
    const { result } = run("native");
    try {
      await Promise.race([entered.promise, result]);
      expect(didEnter).toBe(true);
      expect(mocks.restoreCommit).not.toHaveBeenCalled();
      if (change === "missing") {
        current = undefined;
      } else if (change === "retired") {
        mocks.owned.mockImplementationOnce(() => {
          throw new Error("Retired source");
        });
      } else {
        currentSource = { ...source, agentId: "successor-owner" };
      }
    } finally {
      released.resolve();
      await result;
    }
    expect(mocks.restoreCommit).not.toHaveBeenCalled();
    expect(mocks.databaseWrite).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
  },
);

it("retains the captured environment through cold restoration and admitted native writes", async () => {
  const entered = createDeferredCore();
  const released = createDeferredCore();
  let didEnter = false;
  mocks.restore.mockImplementation(
    async (scope: { env?: NodeJS.ProcessEnv }, assertCurrent?: () => void) => {
      didEnter = true;
      entered.resolve();
      await released.promise;
      if (scope.env !== capturedEnv) {
        throw new Error("Cold restoration lost its captured environment");
      }
      assertCurrent?.();
      mocks.restoreCommit();
    },
  );
  const { result } = run("native");
  try {
    await Promise.race([entered.promise, result]);
    expect(didEnter).toBe(true);
    ambientSource = { agentId: "ambient-successor", path: "/synthetic/ambient-successor" };
  } finally {
    released.resolve();
    await result;
  }
  expect(mocks.restoreCommit).toHaveBeenCalledOnce();
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith({ ...target, env: capturedEnv });
  expect(mocks.append).toHaveBeenCalledOnce();
  expect(mocks.warn).not.toHaveBeenCalled();
});

it.each(["current", "lifecycle", "writer"] as const)(
  "honors a %s inherited fence independently of the captured native row",
  async (claim) => {
    mocks.fence.mockReturnValue({
      expectedLifecycleRevision: claim === "lifecycle" ? "retired-lifecycle" : "original-lifecycle",
      expectedWriterRunId: claim === "writer" ? "retired-writer" : "original-writer",
    });
    await run("native").result;
    if (claim === "current") {
      expect(mocks.append).toHaveBeenCalledOnce();
      expect(mocks.flush).toHaveBeenCalledOnce();
      expect(mocks.warn).not.toHaveBeenCalled();
    } else {
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.flush).not.toHaveBeenCalled();
      expect(mocks.warn).toHaveBeenCalledOnce();
    }
  },
);
