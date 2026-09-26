// Direct compaction caller coverage; existing provider/model/Docker boundaries remain stubbed.
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SandboxContext } from "../sandbox/types.js";
import {
  buildEmbeddedSystemPromptMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveSandboxContextMock,
} from "./compact.hooks.harness.js";

let compactEmbeddedAgentSessionDirect: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let TEST_WORKSPACE_DIR: string;
const TEST_SESSION_ID = "session-1";
const TEST_SESSION_KEY = "agent:main:session-1";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    const databases = await import("../../state/openclaw-agent-db.js");
    const state = await import("../../state/openclaw-state-db.js");
    const settled = await Promise.allSettled([
      databases.closeOpenClawAgentDatabasesAsync(),
      state.closeOpenClawStateDatabaseAsync(),
    ]);
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Compaction reporting fixture cleanup failed");
    }
    cleanup();
  }),
);

beforeAll(async () => {
  ({ compactEmbeddedAgentSessionDirect } = await loadCompactHooksHarness());
});

beforeEach(async () => {
  TEST_WORKSPACE_DIR = tempDirs.make("openclaw-compact-elevation-");
  resetCompactHooksHarnessMocks(TEST_WORKSPACE_DIR);
  const { upsertSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
  await upsertSessionEntryCore(
    {
      agentId: "main",
      sessionKey: TEST_SESSION_KEY,
      storePath: join(TEST_WORKSPACE_DIR, "sessions.json"),
    },
    { sessionId: TEST_SESSION_ID, updatedAt: 1 },
  );
});

it.each([
  { name: "disabled", enabled: false, allowed: false, required: false },
  { name: "enabled but disallowed", enabled: true, allowed: false, required: false },
  { name: "required and enabled", enabled: true, allowed: true, required: true },
])("reads compaction elevation policy only when configured ($name)", async (testCase) => {
  const reporting = await import("./sandbox-info.js");
  const realReporting =
    await vi.importActual<typeof import("./sandbox-info.js")>("./sandbox-info.js");
  const approvalStore = await import("../../infra/exec-approvals-store.js");
  const { patchSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
  const { createSandboxTestContext } = await import("../sandbox/test-fixtures.js");
  const policyRead = vi.mocked(reporting.resolveEmbeddedSandboxInfoExecPolicy);
  const buildInfo = vi.mocked(reporting.buildEmbeddedSandboxInfo);
  const originalPolicy = policyRead.getMockImplementation();
  const originalBuildInfo = buildInfo.getMockImplementation();
  const approvalRead = vi.spyOn(approvalStore, "loadExecApprovalsReadOnlyAsync");
  // Only surrounding provider/model/Docker boundaries remain stubbed by this harness.
  // The reporting owner, session classification and approval worker are real in this case.
  policyRead.mockClear().mockImplementation(realReporting.resolveEmbeddedSandboxInfoExecPolicy);
  buildInfo.mockClear().mockImplementation(realReporting.buildEmbeddedSandboxInfo);
  try {
    const storePath = join(TEST_WORKSPACE_DIR, "sessions.json");
    if (testCase.required) {
      await patchSessionEntryCore(
        { agentId: "main", sessionKey: TEST_SESSION_KEY, storePath },
        () => ({ sandbox: "required" }),
      );
    }
    resolveSandboxContextMock.mockResolvedValue(
      createSandboxTestContext({
        overrides: {
          sessionKey: TEST_SESSION_KEY,
          workspaceDir: TEST_WORKSPACE_DIR,
          agentWorkspaceDir: TEST_WORKSPACE_DIR,
          ...(testCase.required
            ? ({ required: true } satisfies Pick<SandboxContext, "required">)
            : {}),
        },
      }),
    );
    const result = await compactEmbeddedAgentSessionDirect({
      agentId: "main",
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_SESSION_KEY,
      sessionTarget: {
        agentId: "main",
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_SESSION_KEY,
        storePath,
      },
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
        session: { store: storePath },
        tools: { exec: { host: "gateway", mode: "full" } },
      },
      bashElevated: {
        enabled: testCase.enabled,
        allowed: testCase.allowed,
        defaultLevel: "off",
      },
    });
    const info = buildEmbeddedSystemPromptMock.mock.calls.at(-1)?.[0]?.sandboxInfo;
    expect(result.ok).toBe(true);
    expect(info).toMatchObject({ enabled: true, workspaceDir: TEST_WORKSPACE_DIR });
    if (testCase.enabled) {
      expect(policyRead).toHaveBeenCalled();
      if (!testCase.required) {
        expect(approvalRead).toHaveBeenCalled();
      }
      expect(info?.elevated).toMatchObject({
        allowed: false,
        fullAccessAvailable: false,
        fullAccessBlockedReason: "host-policy",
      });
    } else {
      expect(policyRead).not.toHaveBeenCalled();
      expect(approvalRead).not.toHaveBeenCalled();
      expect(info?.elevated).toBeUndefined();
    }
  } finally {
    approvalRead.mockRestore();
    if (originalPolicy) {
      policyRead.mockImplementation(originalPolicy);
    } else {
      policyRead.mockReset();
    }
    if (originalBuildInfo) {
      buildInfo.mockImplementation(originalBuildInfo);
    } else {
      buildInfo.mockReset();
    }
  }
});

it("refuses sandbox metadata publication after cancellation during machine-name preparation", async () => {
  const { createDeferred } = await import("../../../test/helpers/promise.js");
  const { AsyncWorkScope } = await import("../../shared/async-work-scope.js");
  const machineNames = await import("../../infra/machine-name.js");
  const reporting = await import("./sandbox-info.js");
  const realReporting =
    await vi.importActual<typeof import("./sandbox-info.js")>("./sandbox-info.js");
  const { createSandboxTestContext } = await import("../sandbox/test-fixtures.js");
  const machineName = vi.mocked(machineNames.getMachineDisplayName);
  const originalMachineName = machineName.getMockImplementation();
  if (!originalMachineName) {
    throw new Error("Expected the existing external machine-name harness boundary");
  }
  const policyRead = vi.mocked(reporting.resolveEmbeddedSandboxInfoExecPolicy);
  const buildInfo = vi.mocked(reporting.buildEmbeddedSandboxInfo);
  const originalPolicy = policyRead.getMockImplementation();
  const originalBuildInfo = buildInfo.getMockImplementation();
  const reached = createDeferred();
  const released = createDeferred();
  const controller = new AbortController();
  const reason = new Error("synthetic cancellation before compaction sandbox metadata");
  const owner = new AsyncWorkScope();
  let pending: ReturnType<typeof compactEmbeddedAgentSessionDirect> | undefined;
  machineName.mockImplementationOnce(async () => {
    const value = await originalMachineName();
    reached.resolve();
    await released.promise;
    return value;
  });
  policyRead.mockClear().mockImplementation(realReporting.resolveEmbeddedSandboxInfoExecPolicy);
  buildInfo.mockClear().mockImplementation(realReporting.buildEmbeddedSandboxInfo);
  try {
    const storePath = join(TEST_WORKSPACE_DIR, "sessions.json");
    resolveSandboxContextMock.mockResolvedValue(
      createSandboxTestContext({
        overrides: {
          sessionKey: TEST_SESSION_KEY,
          workspaceDir: TEST_WORKSPACE_DIR,
          agentWorkspaceDir: TEST_WORKSPACE_DIR,
        },
      }),
    );
    pending = owner.track(() =>
      compactEmbeddedAgentSessionDirect({
        agentId: "main",
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_SESSION_KEY,
        sessionTarget: {
          agentId: "main",
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_SESSION_KEY,
          storePath,
        },
        workspaceDir: TEST_WORKSPACE_DIR,
        config: {
          agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
          session: { store: storePath },
          tools: { exec: { host: "gateway", mode: "full" } },
        },
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        abortSignal: controller.signal,
      }),
    );
    await Promise.race([
      reached.promise,
      pending.then(() => {
        throw new Error("Compaction finished before reaching the machine-name barrier");
      }),
    ]);
    controller.abort(reason);
    released.resolve();
    const result = await pending;
    // The facade's result can precede cleanup; join all work captured from this real owner.
    await owner.drain();
    expect(buildInfo).not.toHaveBeenCalled();
    expect(buildEmbeddedSystemPromptMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, compacted: false, reason: reason.message });
  } finally {
    released.resolve();
    await Promise.allSettled(pending ? [pending] : []);
    await owner.drain();
    machineName.mockReset().mockImplementation(originalMachineName);
    if (originalPolicy) {
      policyRead.mockImplementation(originalPolicy);
    } else {
      policyRead.mockReset();
    }
    if (originalBuildInfo) {
      buildInfo.mockImplementation(originalBuildInfo);
    } else {
      buildInfo.mockReset();
    }
  }
});
