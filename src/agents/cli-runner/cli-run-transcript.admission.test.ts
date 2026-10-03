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
  open: vi.fn(),
  getTarget: vi.fn<() => SessionTranscriptRuntimeTarget | undefined>(),
  admit: vi.fn<(write: () => void | Promise<void>) => Promise<void>>(),
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
  withSessionTranscriptWriteAssertion: (
    _scope: SessionTranscriptRuntimeTarget,
    assertCurrent: () => void,
    write: () => Promise<void>,
  ) => {
    assertCurrent();
    return mocks.admit(async () => {
      assertCurrent();
      await write();
    });
  },
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
vi.mock("../agent-scope.js", () => ({ resolveSessionAgentId: () => "logical" }));
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
    openAsync: mocks.open,
    inMemory: () => ({
      getSessionTarget: mocks.getTarget,
      appendMessageAsync: mocks.append,
    }),
  },
}));
vi.mock("../sessions/session-manager-write-admission.js", () => ({
  withSessionManagerWrite: (
    manager: Pick<SessionManager, "getSessionTarget">,
    write: () => void | Promise<void>,
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
  mocks.open.mockImplementation(async () => SessionManager.inMemory());
  mocks.admit.mockImplementation(async (write) => write());
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

function deferOperation() {
  const queued = createDeferredCore();
  const released = createDeferredCore();
  let didQueue = false;
  return {
    enter: async () => {
      didQueue = true;
      queued.resolve();
      await released.promise;
    },
    wait: async (result: Promise<void>) => {
      await Promise.race([queued.promise, result]);
      expect(didQueue).toBe(true);
    },
    release: () => released.resolve(),
  };
}

function deferAdmission() {
  const admission = deferOperation();
  mocks.admit.mockImplementation(async (write) => {
    await admission.enter();
    await write();
  });
  return admission;
}

function deferRestoration() {
  const restoration = deferOperation();
  mocks.restore.mockImplementation(
    async (scope: { env?: NodeJS.ProcessEnv }, assertCurrent?: () => void) => {
      await restoration.enter();
      if (scope.env !== capturedEnv) {
        throw new Error("Cold restoration lost its captured environment");
      }
      assertCurrent?.();
      mocks.restoreCommit();
    },
  );
  return restoration;
}

it.each(["native", "supplied"] as const)(
  "waits for %s admission before appending",
  async (branch) => {
    const admission = deferAdmission();
    const { params, result } = run(branch);
    try {
      await admission.wait(result);
      expect(mocks.append).not.toHaveBeenCalled();
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
    expect(params.onUserMessagePersisted).not.toHaveBeenCalled();
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
    }
  },
);

it("leaves supplied initial-writer creation with the session manager", async () => {
  current = undefined;
  await run("supplied").result;
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.append).toHaveBeenCalledOnce();
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

it("refuses a changed store owner before deferred cold restoration mutates it", async () => {
  const restoration = deferRestoration();
  const { result } = run("native");
  try {
    await restoration.wait(result);
    expect(mocks.restoreCommit).not.toHaveBeenCalled();
    currentSource = { ...source, agentId: "successor-owner" };
  } finally {
    restoration.release();
    await result;
  }
  expect(mocks.restoreCommit).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.append).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalledOnce();
});

it("retains the captured environment through cold restoration and admitted native writes", async () => {
  const restoration = deferRestoration();
  const { result } = run("native");
  try {
    await restoration.wait(result);
    ambientSource = { agentId: "ambient-successor", path: "/synthetic/ambient-successor" };
  } finally {
    restoration.release();
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
      expect(mocks.warn).not.toHaveBeenCalled();
    } else {
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.warn).toHaveBeenCalledOnce();
    }
  },
);
