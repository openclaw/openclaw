import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerMatrixApprovalReactionTarget as registerMatrixApprovalReactionTargetRaw,
  resolveMatrixApprovalReactionTargetWithPersistence as resolveMatrixApprovalReactionTargetWithPersistenceRaw,
  unregisterMatrixApprovalReactionTarget as unregisterMatrixApprovalReactionTargetRaw,
} from "./approval-reactions.js";
import { setMatrixRuntime } from "./runtime.js";

const { clearRuntime: clearMatrixRuntime } = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "matrix",
  errorMessage: "Matrix runtime not initialized",
});

type RegisterTargetParams = Parameters<typeof registerMatrixApprovalReactionTargetRaw>[0];
type ResolveTargetParams = Parameters<
  typeof resolveMatrixApprovalReactionTargetWithPersistenceRaw
>[0];
type UnregisterTargetParams = Parameters<typeof unregisterMatrixApprovalReactionTargetRaw>[0];
const touchedTargetRefs = new Map<string, UnregisterTargetParams>();
const anchor = { roomId: "!ops:example.org", eventId: "$approval-msg" };
const approval = { ...anchor, approvalId: "req-123", approvalKind: "exec" as const };

function rememberTargetRef({ accountId, roomId, eventId }: UnregisterTargetParams): void {
  const ref = { accountId, roomId, eventId };
  touchedTargetRefs.set(JSON.stringify(ref), ref);
}

async function registerTarget(params: Partial<RegisterTargetParams> = {}): Promise<void> {
  const target = {
    accountId: "default",
    ...approval,
    allowedDecisions: ["allow-once" as const],
    ...params,
  };
  rememberTargetRef(target);
  await registerMatrixApprovalReactionTargetRaw(target);
}

function resolveTarget(params: Partial<ResolveTargetParams> = {}) {
  const target = { accountId: "default", ...anchor, reactionKey: "✅", ...params };
  rememberTargetRef(target);
  return resolveMatrixApprovalReactionTargetWithPersistenceRaw(target);
}

function createRuntimeLogger(overrides: { warn?: ReturnType<typeof vi.fn> } = {}) {
  // Runtime state survives no-isolate workers, so expose every logger method later files may call.
  return { debug: vi.fn(), info: vi.fn(), warn: overrides.warn ?? vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  clearMatrixRuntime();
});

afterEach(async () => {
  for (const target of touchedTargetRefs.values()) {
    await unregisterMatrixApprovalReactionTargetRaw(target);
  }
  touchedTargetRefs.clear();
  clearMatrixRuntime();
  vi.restoreAllMocks();
});

describe("matrix approval reactions", () => {
  it("ignores reactions that are not allowed on the registered approval anchor event", async () => {
    await registerTarget({ allowedDecisions: ["allow-once", "deny"] });
    expect(await resolveTarget({ reactionKey: "♾️" })).toBeNull();
  });

  it("does not expose an approval reaction target to another Matrix account", async () => {
    const shared = { roomId: "!shared:example.org", eventId: "$approval-msg" };
    await registerTarget({
      accountId: "account-a",
      ...shared,
      approvalId: "req-account-a",
    });

    expect(await resolveTarget({ accountId: "account-b", ...shared })).toBeNull();
    expect(await resolveTarget({ accountId: "account-a", ...shared })).toEqual({
      approvalId: "req-account-a",
      approvalKind: "exec",
      decision: "allow-once",
    });
  });

  it("rejects reaction targets without a valid approval kind", async () => {
    await registerTarget({ approvalKind: "invalid" } as never);
    expect(await resolveTarget()).toBeNull();
  });

  it("persists system-agent approval reaction targets when runtime state is available", async () => {
    const approvalKind = "system-agent" as const;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const warn = vi.fn();
    const register = vi.fn().mockResolvedValue(undefined);
    const persistedAnchor = { roomId: "!ops:example.org", eventId: "$approval-msg-2" };
    const record = {
      version: 1,
      target: {
        ...approval,
        accountId: "default",
        approvalKind,
        ...persistedAnchor,
        allowedDecisions: ["allow-once", "deny"] as const,
      },
    };
    const lookup = vi.fn().mockResolvedValue(record);
    const openKeyedStore = vi.fn(() => ({
      register,
      lookup,
      consume: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setMatrixRuntime({
      state: { openKeyedStoreV2: openKeyedStore },
      logging: { getChildLogger: () => createRuntimeLogger({ warn }) },
    } as never);

    await registerTarget({ ...record.target, ttlMs: 1 });

    expect(register).toHaveBeenCalledExactlyOnceWith(
      '["default","!ops:example.org","$approval-msg-2"]',
      record,
      { ttlMs: 1 },
    );

    now.mockReturnValue(1_005);
    await expect(resolveTarget({ ...persistedAnchor, reactionKey: "❌" })).resolves.toEqual({
      approvalId: "req-123",
      approvalKind,
      decision: "deny",
    });
    expect(openKeyedStore).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith('["default","!ops:example.org","$approval-msg-2"]');

    register.mockRejectedValueOnce(new Error("sqlite unavailable"));
    await registerTarget({
      eventId: "$approval-msg-3",
      approvalId: "req-fallback",
      approvalKind,
      allowedDecisions: ["deny"],
    });
    expect(warn).toHaveBeenCalled();

    expect(
      await resolveTarget({
        eventId: "$approval-msg-3",
        reactionKey: "❌",
      }),
    ).toEqual({ approvalId: "req-fallback", approvalKind, decision: "deny" });
  });
});
