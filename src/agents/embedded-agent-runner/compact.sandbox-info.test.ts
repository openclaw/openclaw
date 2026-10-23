import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  buildConfiguredAgentSystemPromptMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveSandboxContextMock,
} from "./compact.hooks.harness.js";

let compactEmbeddedAgentSessionDirect: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let TEST_WORKSPACE_DIR: string;
let sessionTarget: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
let reporting: Awaited<ReturnType<typeof loadSandboxReporting>>;
const session = { agentId: "main", sessionId: "session-1", sessionKey: "agent:main:session-1" };
let tempDirs: ReturnType<
  typeof import("../../test-utils/session-state-cleanup.js").useSessionStoreTempDirs
>;
let cleanup: () => Promise<void>;
afterEach(() => cleanup());

beforeAll(async () => {
  ({ compactEmbeddedAgentSessionDirect } = await loadCompactHooksHarness());
  reporting = await loadSandboxReporting();
  const { useSessionStoreTempDirs } = await import("../../test-utils/session-state-cleanup.js");
  tempDirs = useSessionStoreTempDirs((close) => {
    cleanup = close;
  }, "openclaw-compact-elevation-");
});
afterAll(() => {
  reporting.policyRead.mockReset();
  reporting.buildInfo.mockReset();
});

beforeEach(async () => {
  TEST_WORKSPACE_DIR = tempDirs.make();
  resetCompactHooksHarnessMocks(TEST_WORKSPACE_DIR);
  reporting.policyRead.mockClear();
  reporting.buildInfo.mockClear();
  sessionTarget = {
    ...session,
    storePath: join(TEST_WORKSPACE_DIR, "sessions.json"),
  };
  const { upsertSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
  await upsertSessionEntryCore(sessionTarget, { sessionId: session.sessionId, updatedAt: 1 });
});

async function loadSandboxReporting() {
  const mocked = await import("./sandbox-info.js");
  const realReporting =
    await vi.importActual<typeof import("./sandbox-info.js")>("./sandbox-info.js");
  return {
    policyRead: vi
      .mocked(mocked.resolveEmbeddedSandboxInfoExecPolicy)
      .mockImplementation(realReporting.resolveEmbeddedSandboxInfoExecPolicy),
    buildInfo: vi
      .mocked(mocked.buildEmbeddedSandboxInfo)
      .mockImplementation(realReporting.buildEmbeddedSandboxInfo),
  };
}

async function compactionParams(required = false) {
  const { createSandboxTestContext } = await import("../sandbox/test-fixtures.js");
  resolveSandboxContextMock.mockResolvedValue(
    createSandboxTestContext({
      overrides: {
        sessionKey: session.sessionKey,
        workspaceDir: TEST_WORKSPACE_DIR,
        agentWorkspaceDir: TEST_WORKSPACE_DIR,
        ...(required ? { required: true as const } : {}),
      },
    }),
  );
  const { storePath, ...target } = sessionTarget;
  return {
    ...target,
    sessionTarget,
    workspaceDir: TEST_WORKSPACE_DIR,
    config: {
      agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      session: { store: storePath },
      tools: { exec: { host: "gateway", mode: "full" } },
    },
  } satisfies Parameters<typeof compactEmbeddedAgentSessionDirect>[0];
}

it.each([
  { name: "disabled", enabled: false, allowed: false, required: false },
  { name: "enabled but disallowed", enabled: true, allowed: false, required: false },
  { name: "required and enabled", enabled: true, allowed: true, required: true },
])("reads compaction elevation policy only when configured ($name)", async (testCase) => {
  const params = await compactionParams(testCase.required);
  const { policyRead } = reporting;
  const approvalStore = await import("../../infra/exec-approvals-store.js");
  const { patchSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
  const approvalRead = vi.spyOn(approvalStore, "loadExecApprovalsReadOnlyAsync");
  onTestFinished(() => approvalRead.mockRestore());
  if (testCase.required) {
    const { sessionId: _sessionId, ...scope } = params.sessionTarget;
    await patchSessionEntryCore(scope, () => ({ sandbox: "required" }));
  }
  const result = await compactEmbeddedAgentSessionDirect({
    ...params,
    bashElevated: {
      enabled: testCase.enabled,
      allowed: testCase.allowed,
      defaultLevel: "off",
    },
  });
  const info = buildConfiguredAgentSystemPromptMock.mock.calls.at(-1)?.[0]?.sandboxInfo;
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
});

it("refuses sandbox metadata publication after cancellation during machine-name preparation", async () => {
  const { AsyncWorkScope } = await import("../../shared/async-work-scope.js");
  const machineNames = await import("../../infra/machine-name.js");
  const params = await compactionParams();
  const machineName = vi.mocked(machineNames.getMachineDisplayName);
  const originalMachineName = machineName.getMockImplementation();
  if (!originalMachineName) {
    throw new Error("Expected the existing external machine-name harness boundary");
  }
  const { buildInfo } = reporting;
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
  try {
    pending = owner.track(() =>
      compactEmbeddedAgentSessionDirect({
        ...params,
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        abortSignal: controller.signal,
      }),
    );
    await awaitGateBeforeSettlement(
      reached.promise,
      pending,
      "Compaction finished before reaching the machine-name barrier",
    );
    controller.abort(reason);
    released.resolve();
    const result = await pending;
    // The facade's result can precede cleanup; join all work captured from this real owner.
    await owner.drain();
    expect(buildInfo).not.toHaveBeenCalled();
    expect(buildConfiguredAgentSystemPromptMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, compacted: false, reason: reason.message });
  } finally {
    released.resolve();
    await Promise.allSettled(pending ? [pending] : []);
    await owner.drain();
    machineName.mockReset().mockImplementation(originalMachineName);
  }
});
