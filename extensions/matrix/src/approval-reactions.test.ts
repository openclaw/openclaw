import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerMatrixApprovalReactionTarget as register,
  resolveMatrixApprovalReactionTargetWithPersistence as resolve,
  unregisterMatrixApprovalReactionTarget as unregister,
} from "./approval-reactions.js";
import { setMatrixRuntime } from "./runtime.js";

const { clearRuntime: clearMatrixRuntime } = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "matrix",
  errorMessage: "Matrix runtime not initialized",
});

const targets: Parameters<typeof unregister>[0][] = [];
const anchor = { accountId: "default", roomId: "!ops:example.org", eventId: "$approval-msg" };
const approval = { ...anchor, approvalId: "req-123", approvalKind: "exec" as const };

async function registerTarget(params: Partial<Parameters<typeof register>[0]> = {}): Promise<void> {
  const target = { ...approval, allowedDecisions: ["allow-once" as const], ...params };
  targets.push(target);
  await register(target);
}

function resolveTarget(params: Partial<Parameters<typeof resolve>[0]> = {}) {
  return resolve({ ...anchor, reactionKey: "✅", ...params });
}

beforeEach(clearMatrixRuntime);

afterEach(async () => {
  for (const target of targets.splice(0)) {
    await unregister(target);
  }
  clearMatrixRuntime();
  vi.restoreAllMocks();
});

describe("matrix approval reactions", () => {
  it("ignores reactions that are not allowed on the registered approval anchor event", async () => {
    await registerTarget({ allowedDecisions: ["allow-once", "deny"] });
    expect(await resolveTarget({ reactionKey: "♾️" })).toBeNull();
  });

  it("does not expose an approval reaction target to another Matrix account", async () => {
    await registerTarget({ accountId: "account-a" });

    expect(await resolveTarget({ accountId: "account-b" })).toBeNull();
    expect(await resolveTarget({ accountId: "account-a" })).toEqual({
      approvalId: approval.approvalId,
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
    const persist = vi.fn().mockResolvedValue(undefined);
    const persistedAnchor = { roomId: "!ops:example.org", eventId: "$approval-msg-2" };
    const record = {
      version: 1,
      target: {
        ...approval,
        approvalKind,
        ...persistedAnchor,
        allowedDecisions: ["allow-once", "deny"] as const,
      },
    };
    const store = {
      register: persist,
      lookup: vi.fn().mockResolvedValue(record),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    setMatrixRuntime({
      state: { openKeyedStoreV2: () => store },
      logging: { getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }) },
    } as never);

    await registerTarget({ ...record.target, ttlMs: 1 });

    expect(persist).toHaveBeenCalledExactlyOnceWith(
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
    expect(store.lookup).toHaveBeenCalledWith('["default","!ops:example.org","$approval-msg-2"]');

    persist.mockRejectedValueOnce(new Error("sqlite unavailable"));
    await registerTarget({
      eventId: "$approval-msg-3",
      approvalId: "req-fallback",
      approvalKind,
      allowedDecisions: ["deny"],
    });
    expect(warn).toHaveBeenCalled();

    expect(await resolveTarget({ eventId: "$approval-msg-3", reactionKey: "❌" })).toEqual({
      approvalId: "req-fallback",
      approvalKind,
      decision: "deny",
    });
  });
});
