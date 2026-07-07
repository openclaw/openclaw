import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerArmState, ComputerArmStore } from "./arm-state.js";
import { createComputerInputPolicy } from "./input-policy.js";

function createStore(initial?: ComputerArmState) {
  let state = initial;
  const store: ComputerArmStore = {
    lookup: vi.fn(async () => state),
    register: vi.fn(async (_key, value) => {
      state = value;
    }),
    delete: vi.fn(async () => {
      const existed = state !== undefined;
      state = undefined;
      return existed;
    }),
    entries: vi.fn(async () => []),
  };
  return { store, read: () => state };
}

function createContext(input?: {
  platform?: string;
  approvalDecision?: "allow-once" | "allow-always" | "deny" | null;
}) {
  const request = vi.fn(async () => ({
    id: "approval-1",
    decision: input?.approvalDecision === undefined ? "allow-once" : input.approvalDecision,
  }));
  const invokeNode = vi.fn(async () => ({ ok: true as const, payload: { ok: true } }));
  const ctx: OpenClawPluginNodeInvokePolicyContext = {
    nodeId: "node-1",
    command: "computer.input",
    params: { action: "click", button: "left", count: 1 },
    timeoutMs: 30_000,
    config: {},
    pluginConfig: { defaultArmDurationMs: 60_000 },
    node: {
      nodeId: "node-1",
      displayName: "Studio Mac",
      platform: input?.platform ?? "macos",
      commands: ["computer.input"],
    },
    client: { connId: "operator-1" },
    approvals: { request },
    invokeNode,
  };
  return { ctx, invokeNode, request };
}

function createPolicy(store: ComputerArmStore) {
  return createComputerInputPolicy({
    armStore: store,
    api: { pluginConfig: { defaultArmDurationMs: 60_000 } },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computer input policy", () => {
  it("requests approval when the node is not armed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { store } = createStore();
    const { ctx, request } = createContext();

    await createPolicy(store).handle(ctx);

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Computer control",
        severity: "critical",
        toolName: "computer",
        timeoutMs: 30_000,
      }),
    );
  });

  it.each(["deny", null] as const)(
    "denies without invoking when approval resolves to %s",
    async (approvalDecision) => {
      const { store } = createStore();
      const { ctx, invokeNode } = createContext({ approvalDecision });

      const result = await createPolicy(store).handle(ctx);

      expect(result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
      expect(invokeNode).not.toHaveBeenCalled();
    },
  );

  it("invokes once without arming for allow-once", async () => {
    const { store, read } = createStore();
    const { ctx, invokeNode } = createContext({ approvalDecision: "allow-once" });

    const result = await createPolicy(store).handle(ctx);

    expect(result.ok).toBe(true);
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expect(read()).toBeUndefined();
  });

  it("arms with the configured expiry and invokes for allow-always", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { store, read } = createStore();
    const { ctx, invokeNode } = createContext({ approvalDecision: "allow-always" });

    const result = await createPolicy(store).handle(ctx);

    expect(result.ok).toBe(true);
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expect(read()).toEqual({
      armedAtMs: 1000,
      expiresAtMs: 61_000,
      armedBy: "operator-1",
    });
  });

  it("invokes an already armed node without requesting approval", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { store } = createStore({ armedAtMs: 0, expiresAtMs: 2000 });
    const { ctx, invokeNode, request } = createContext();

    const result = await createPolicy(store).handle(ctx);

    expect(result.ok).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });

  it("rejects non-macOS nodes before approval or invocation", async () => {
    const { store } = createStore();
    const { ctx, invokeNode, request } = createContext({ platform: "linux" });

    const result = await createPolicy(store).handle(ctx);

    expect(result).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_PLATFORM",
      unavailable: true,
    });
    expect(request).not.toHaveBeenCalled();
    expect(invokeNode).not.toHaveBeenCalled();
  });
});
