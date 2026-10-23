import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  SessionTranscriptRuntimeTarget,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import { publishRetainedSessionEntryChange } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { projectSessionSharingEntry } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
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
// mock-isolation: Admission fixtures control transcript paths and patch settlement independently of storage.
vi.mock("../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: mocks.patch,
  resolveSessionTranscriptDatabasePath: mocks.resolvePath,
}));
// mock-isolation: The retained entry fixture controls writer replacement during admission.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: mocks.read,
}));
vi.mock("../../config/sessions/session-store-owner.js", () => ({
  resolvePersistedSessionStoreOwnerForTarget: () => ({ kind: "none" }),
}));
// mock-isolation: This durable admission fixture has no memory owner.
vi.mock("../../config/sessions/session-actor-storage-binding.js", () => ({
  captureSessionActorStorageOwner: () => undefined,
  getSessionActorStorageBinding: () => undefined,
  acquireSessionActorStorage: async () => undefined,
  runWithSessionActorStorage: (_binding: unknown, consume: () => unknown) => consume(),
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
// mock-isolation: Transcript admission controls persistence directly; unrelated agent-end effects stay inert.
vi.mock("../harness/agent-end-side-effects.js", () => ({
  awaitAgentEndSideEffects: vi.fn(),
  runAgentEndSideEffectsAsync: vi.fn(),
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
const source = {
  agentId: "physical-owner",
  path: "/synthetic/shared/openclaw-agent.sqlite",
  databaseIdentity: "cli-block-fixture",
} satisfies CapturedSessionEntryReadSource;
let current: InternalSessionEntry | undefined;
let capturedEnv: NodeJS.ProcessEnv;

afterEach(assertNoRetainedSessionSharingReads);

beforeEach(() => {
  vi.resetAllMocks();
  current = {
    sessionId: target.sessionId,
    updatedAt: 1,
    lifecycleRevision: "original-lifecycle",
    activeWriterRunId: "original-writer",
  };
  capturedEnv = { OPENCLAW_STATE_DIR: "/synthetic/state" };
  mocks.cloneEnv.mockReturnValue(capturedEnv);
  mocks.restore.mockImplementation(async (_scope, assertCurrent?: () => void) => assertCurrent?.());
  mocks.getTarget.mockReturnValue(target);
  mocks.open.mockImplementation(async () => SessionManager.inMemory());
  mocks.admit.mockImplementation(async (write) => write());
  mocks.patch.mockImplementation(
    async (_target, _update, options: NonNullable<Parameters<typeof patchSessionEntryCore>[2]>) => {
      const entry = current ? { ...current } : null;
      if (entry) {
        options.onCommittedSource?.(source, entry);
      }
      return entry;
    },
  );
  mocks.resolvePath.mockReturnValue(source.path);
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

async function during(
  branch: "native" | "supplied",
  action: (params: RunCliAgentParams) => void,
  phase: "admission" | "restoration" = "admission",
) {
  const queued = createDeferredCore();
  const released = createDeferredCore();
  let didQueue = false;
  const enter = async () => {
    didQueue = true;
    queued.resolve();
    await released.promise;
  };
  if (phase === "admission") {
    mocks.admit.mockImplementation(async (write) => {
      await enter();
      await write();
    });
  } else {
    mocks.restore.mockImplementation(
      async (scope: { env?: NodeJS.ProcessEnv }, assertCurrent?: () => void) => {
        await enter();
        if (scope.env !== capturedEnv) {
          throw new Error("Cold restoration lost its captured environment");
        }
        assertCurrent?.();
        mocks.restoreCommit();
      },
    );
  }
  const { params, result } = run(branch);
  try {
    await Promise.race([queued.promise, result]);
    expect(didQueue).toBe(true);
    action(params);
  } finally {
    released.resolve();
    await result;
  }
  return params;
}

function expectNoWrite() {
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.append).not.toHaveBeenCalled();
}

function retireSource(message = "Retired source") {
  mocks.owned.mockImplementation(() => {
    throw new Error(message);
  });
}

it.each(["native", "supplied"] as const)(
  "waits for %s admission before appending",
  async (branch) => {
    const params = await during(branch, expectNoWrite);
    expect(mocks.append).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "Policy block" }],
      }),
    );
    expect(params.onUserMessagePersisted).not.toHaveBeenCalled();
  },
);

it.each([
  ["missing", undefined],
  ["session", { sessionId: "successor-session" }],
  ["lifecycle", { lifecycleRevision: "successor-lifecycle" }],
  ["writer", { activeWriterRunId: "successor-writer" }],
] as const)("refuses a %s native target after waiting", async (_change, replacement) => {
  await during("native", () => {
    current = replacement && { ...current!, ...replacement };
    publishRetainedSessionEntryChange(
      source.databaseIdentity,
      target.sessionKey,
      current ? projectSessionSharingEntry(current) : undefined,
      undefined,
      true,
      current,
    );
  });
  expectNoWrite();
  expect(mocks.warn).toHaveBeenCalledOnce();
});

it.each(["native", "supplied"] as const)(
  "rechecks captured %s source and CLI writer after waiting",
  async (branch) => {
    for (const authority of [mocks.owned, mocks.writer]) {
      await during(branch, () => {
        authority.mockImplementationOnce(() => {
          throw new Error("Retired source");
        });
      });
      expect(mocks.append).not.toHaveBeenCalled();
    }
  },
);

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
  await during("native", (params) => {
    params.sessionTarget = {
      ...target,
      sessionId: "successor-session",
      storePath: "/synthetic/successor",
    };
  });
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith({ ...target, env: capturedEnv });
  expect(mocks.append).toHaveBeenCalledOnce();
});

it.each(["retired ownership", "changed ambient environment"])(
  "honors captured authority and environment during cold restoration: %s",
  async (change) => {
    const retired = change === "retired ownership";
    await during(
      "native",
      () => {
        expect(mocks.restoreCommit).not.toHaveBeenCalled();
        if (retired) {
          retireSource();
        } else {
          mocks.cloneEnv.mockReturnValue({ OPENCLAW_STATE_DIR: "/synthetic/ambient-successor" });
        }
      },
      "restoration",
    );
    expect(mocks.restoreCommit).toHaveBeenCalledTimes(retired ? 0 : 1);
    expect(mocks.warn).toHaveBeenCalledTimes(retired ? 1 : 0);
    if (retired) {
      expectNoWrite();
    } else {
      expect(mocks.open).toHaveBeenCalledExactlyOnceWith({ ...target, env: capturedEnv });
      expect(mocks.append).toHaveBeenCalledOnce();
    }
  },
);

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
      expectNoWrite();
      expect(mocks.warn).toHaveBeenCalledOnce();
    }
  },
);

it("releases the fallback read when its final authority check fails", async () => {
  mocks.patch.mockResolvedValue({ ...current });
  mocks.read.mockImplementation(
    async (
      _scope,
      assertCurrent: () => void,
      consume: Parameters<typeof withSessionEntryReadOnlyInWorker>[2],
    ) => {
      const result = await consume(
        { ok: true, value: current },
        { kind: "file", source, assertCurrent },
      );
      retireSource("Retired source after entry read");
      assertCurrent();
      return result;
    },
  );

  await run("native").result;

  expectNoWrite();
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Retired source after entry read"),
  );
});
