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

function rememberTargetRef(params: UnregisterTargetParams): void {
  touchedTargetRefs.set(JSON.stringify(params), params);
}

async function registerTarget(
  params: Omit<RegisterTargetParams, "accountId"> & { accountId?: string },
): Promise<void> {
  const { accountId = "default", ...target } = params;
  rememberTargetRef({ accountId, roomId: target.roomId, eventId: target.eventId });
  await registerMatrixApprovalReactionTargetRaw({ ...target, accountId });
}

function resolveTarget(params: Omit<ResolveTargetParams, "accountId"> & { accountId?: string }) {
  const { accountId = "default", ...target } = params;
  rememberTargetRef({ accountId, roomId: target.roomId, eventId: target.eventId });
  return resolveMatrixApprovalReactionTargetWithPersistenceRaw({ ...target, accountId });
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
    await registerTarget({
      ...approval,
      allowedDecisions: ["allow-once", "deny"],
    });

    expect(await resolveTarget({ ...anchor, reactionKey: "♾️" })).toBeNull();
  });

  it("does not expose an approval reaction target to another Matrix account", async () => {
    const shared = { roomId: "!shared:example.org", eventId: "$approval-msg" };
    await registerTarget({
      accountId: "account-a",
      ...shared,
      approvalId: "req-account-a",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
    });

    await expect(
      resolveTarget({
        accountId: "account-b",
        ...shared,
        reactionKey: "✅",
      }),
    ).resolves.toBeNull();
    await expect(
      resolveTarget({
        accountId: "account-a",
        ...shared,
        reactionKey: "✅",
      }),
    ).resolves.toEqual({
      approvalId: "req-account-a",
      approvalKind: "exec",
      decision: "allow-once",
    });
  });

  it("rejects reaction targets without a valid approval kind", async () => {
    await registerTarget({
      ...anchor,
      approvalId: "req-123",
      approvalKind: "invalid",
      allowedDecisions: ["allow-once"],
    } as never);

    expect(await resolveTarget({ ...anchor, reactionKey: "✅" })).toBeNull();
  });

  it("stops resolving reactions after the approval anchor event is unregistered", async () => {
    await registerTarget({
      ...approval,
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    await unregisterMatrixApprovalReactionTargetRaw({ ...anchor, accountId: "default" });

    expect(await resolveTarget({ ...anchor, reactionKey: "✅" })).toBeNull();
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
        accountId: "default",
        approvalId: "req-123",
        approvalKind,
        ...persistedAnchor,
        allowedDecisions: ["allow-once", "deny"],
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

    await registerTarget({ ...record.target, allowedDecisions: ["allow-once", "deny"], ttlMs: 1 });

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(
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
      roomId: "!ops:example.org",
      eventId: "$approval-msg-3",
      approvalId: "req-fallback",
      approvalKind,
      allowedDecisions: ["deny"],
    });
    expect(warn).toHaveBeenCalled();

    expect(
      await resolveTarget({
        roomId: "!ops:example.org",
        eventId: "$approval-msg-3",
        reactionKey: "❌",
      }),
    ).toEqual({ approvalId: "req-fallback", approvalKind, decision: "deny" });
  });
});
