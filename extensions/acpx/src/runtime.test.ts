import type { AcpRuntimeHandle, AcpRuntimeOptions, AcpSessionStore } from "acpx/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    capturedStore: undefined as AcpSessionStore | undefined,
  };

  class MockAcpxRuntime {
    constructor(options: AcpRuntimeOptions) {
      state.capturedStore = options.sessionStore;
    }

    isHealthy() {
      return true;
    }

    async probeAvailability() {}

    async doctor() {
      return { ok: true, message: "ok" };
    }

    async ensureSession() {
      return {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      } satisfies AcpRuntimeHandle;
    }

    async *runTurn() {}

    getCapabilities() {
      return { controls: [] };
    }

    async getStatus() {
      return {};
    }

    async setMode() {}

    async setConfigOption() {}

    async cancel() {}

    async close() {}
  }

  return {
    state,
    MockAcpxRuntime,
  };
});

vi.mock("acpx/runtime", () => ({
  ACPX_BACKEND_ID: "acpx",
  AcpxRuntime: mocks.MockAcpxRuntime,
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createFileSessionStore: vi.fn(),
  decodeAcpxRuntimeHandleState: vi.fn(),
  encodeAcpxRuntimeHandleState: vi.fn(),
}));

import { AcpxRuntime } from "./runtime.js";

describe("AcpxRuntime fresh reset wrapper", () => {
  beforeEach(() => {
    mocks.state.capturedStore = undefined;
  });

  it("keeps stale persistent loads hidden until a fresh record is saved", async () => {
    const baseStore: AcpSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const runtime = new AcpxRuntime({
      cwd: "/tmp",
      sessionStore: baseStore,
      agentRegistry: {
        resolve: () => "codex",
        list: () => ["codex"],
      },
      permissionMode: "default",
    });

    const wrappedStore = mocks.state.capturedStore;
    expect(wrappedStore).toBeDefined();

    expect(await wrappedStore?.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await runtime.prepareFreshSession({
      sessionKey: "agent:codex:acp:binding:test",
    });

    expect(await wrappedStore?.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);
    expect(await wrappedStore?.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await wrappedStore?.save({
      acpxRecordId: "fresh-record",
      name: "agent:codex:acp:binding:test",
    } as never);

    expect(await wrappedStore?.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(2);
  });

  it("marks the session fresh after discardPersistentState close", async () => {
    const baseStore: AcpSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const runtime = new AcpxRuntime({
      cwd: "/tmp",
      sessionStore: baseStore,
      agentRegistry: {
        resolve: () => "codex",
        list: () => ["codex"],
      },
      permissionMode: "default",
    });

    const wrappedStore = mocks.state.capturedStore;
    expect(wrappedStore).toBeDefined();

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });

    expect(await wrappedStore?.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).not.toHaveBeenCalled();
  });
});
