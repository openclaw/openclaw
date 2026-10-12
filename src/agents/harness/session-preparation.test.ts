import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareAgentHarnessSessionRuntime } from "./session-preparation.js";
const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  closeAdmission: vi.fn(),
  credentials: vi.fn(),
  createHost: vi.fn(),
  closeHost: vi.fn(),
  assertHost: vi.fn(),
}));
vi.mock("../admitted-run-context.js", () => ({
  prepareSystemAgentRunAdmission: () => ({ admit: mocks.admit, close: mocks.closeAdmission }),
}));
vi.mock("../../plugins/loader-runtime-load.js", () => ({
  nativePluginBindings: {
    authStore: { prepareAuthProfileStoreForModelRuntime: mocks.credentials },
  },
}));
vi.mock("./host-capability.js", () => ({ createAgentHarnessHostCapabilities: mocks.createHost }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.admit.mockResolvedValue({ operationalRunInstance: { runId: "prepared" } });
  mocks.credentials.mockResolvedValue({ version: 1, profiles: {} });
  mocks.createHost.mockReturnValue({
    capabilities: { assertActive: mocks.assertHost },
    close: mocks.closeHost,
    runWithScope: (run: () => Promise<unknown>) => run(),
  });
});
const input = {
  config: {},
  agentId: "main",
  agentDir: "/test/agent",
  sessionId: "session",
  sessionKey: "agent:main:app",
  workspaceDir: "/test/workspace",
  provider: "openai",
  modelId: "test-model",
};
describe("native session-only preparation admission", () => {
  it("uses admitted host authority without manufacturing a model attempt or prompt", async () => {
    const prepared = await prepareAgentHarnessSessionRuntime({
      ownerPluginId: "codex",
      input,
      assertCurrent: () => {},
    });
    expect(mocks.admit).toHaveBeenCalledWith("plugin-harness");
    expect(prepared.preparation.version).toBe(1);
    expect(prepared.preparation.params).not.toHaveProperty("prompt");
    expect(prepared.preparation.params).not.toHaveProperty("sessionFile");
    expect(prepared.preparation.params.hostCapabilities).toBe(
      mocks.createHost.mock.results[0]!.value.capabilities,
    );
    await expect(prepared.preparation.run(async () => "started")).resolves.toBe("started");
    prepared.dispose();
    expect(mocks.closeHost).toHaveBeenCalledOnce();
    expect(mocks.closeAdmission).toHaveBeenCalledOnce();
  });
  it("closes admission when source authority disappears during credential preparation", async () => {
    const pending = createDeferred<undefined>();
    const reached = createDeferred();
    mocks.credentials.mockImplementation(() => {
      reached.resolve();
      return pending.promise;
    });
    let active = true;
    const run = prepareAgentHarnessSessionRuntime({
      ownerPluginId: "codex",
      input,
      assertCurrent: () => {
        if (!active) {
          throw new Error("revoked");
        }
      },
    });
    await reached.promise;
    active = false;
    pending.resolve(undefined);
    await expect(run).rejects.toThrow();
    expect(mocks.createHost).not.toHaveBeenCalled();
    expect(mocks.closeAdmission).toHaveBeenCalledOnce();
  });
});
