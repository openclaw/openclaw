import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, expect, it, vi } from "vitest";
import { setSignalRuntime } from "../runtime.js";

const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueSystemEvent: enqueueSystemEventMock,
}));

const { handleSignalReadReceipt } = await import("./read-receipts.js");

const deps = {
  cfg: {},
  accountId: "default",
  account: "+15550000000",
  dmPolicy: "allowlist" as const,
  groupPolicy: "allowlist" as const,
  allowFrom: ["+15550001111"],
  groupAllowFrom: [],
};
const receipt = (sourceNumber: string, receiptMessage: Record<string, unknown>) => ({
  envelope: { sourceNumber, sourceName: "Ada", timestamp: 3, receiptMessage },
});

beforeEach(() => {
  setSignalRuntime(createPluginRuntimeMock());
  enqueueSystemEventMock.mockClear();
});

it("turns an allowed sender's read receipt into system context for that conversation", async () => {
  const handled = await handleSignalReadReceipt(
    deps,
    receipt("+15550001111", { isRead: true, timestamps: [1700000000001] }),
  );
  expect(handled).toBe(true);
  expect(enqueueSystemEventMock).toHaveBeenCalledWith(
    "Signal read receipt: Ada read msg 1700000000001",
    expect.objectContaining({ contextKey: "signal:read:1700000000001:+15550001111" }),
  );
});

it.each([
  ["a delivery receipt", "+15550001111", { isDelivery: true, timestamps: [1] }, false],
  ["a sender outside the allowlist", "+15550009999", { isRead: true, timestamps: [1] }, true],
  ["the account's own receipt", "+15550000000", { isRead: true, timestamps: [1] }, true],
] as const)("adds no system context for %s", async (_label, sender, message, handled) => {
  await expect(handleSignalReadReceipt(deps, receipt(sender, message))).resolves.toBe(handled);
  expect(enqueueSystemEventMock).not.toHaveBeenCalled();
});
