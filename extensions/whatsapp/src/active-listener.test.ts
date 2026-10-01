// Whatsapp tests cover active listener plugin behavior.
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveWebListener, resolveWebAccountId } from "./active-listener.js";

const runtimeContext = vi.hoisted(() => ({
  channelRuntime: undefined as ReturnType<typeof createPluginRuntimeMock>["channel"] | undefined,
}));
vi.mock("./runtime.js", () => ({
  getOptionalWhatsAppChannelRuntime: () => runtimeContext.channelRuntime,
}));

const leases: Array<{ dispose(): void }> = [];
const WHATSAPP_ACTIVE_LISTENER_TEST_CFG = {
  channels: { whatsapp: { accounts: { work: { enabled: true } }, defaultAccount: "work" } },
};

function makeListener() {
  return {
    sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
    sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
    sendReaction: vi.fn(async () => {}),
    sendComposingTo: vi.fn(async () => {}),
  };
}

function registerListener(accountId: string, listener: ReturnType<typeof makeListener> | null) {
  const lease = registerChannelRuntimeContext({
    channelRuntime: runtimeContext.channelRuntime,
    channelId: "whatsapp",
    accountId,
    capability: "connection-controller",
    context: { getActiveListener: () => listener },
  });
  if (!lease) {
    throw new Error("Expected a case-owned WhatsApp runtime registry");
  }
  leases.push(lease);
  return lease;
}

beforeEach(() => {
  runtimeContext.channelRuntime = createPluginRuntimeMock().channel;
});
afterEach(() => {
  for (const lease of leases.splice(0)) {
    lease.dispose();
  }
  runtimeContext.channelRuntime = undefined;
});

describe("active WhatsApp listener view", () => {
  it("resolves the configured default account when accountId is omitted", () => {
    const listener = makeListener();
    const otherListener = makeListener();
    const oldLease = registerListener("work", listener);
    registerListener("other", otherListener);

    expect(resolveWebAccountId({ cfg: WHATSAPP_ACTIVE_LISTENER_TEST_CFG })).toBe("work");
    expect(getActiveWebListener("work")).toBe(listener);
    expect(getActiveWebListener("other")).toBe(otherListener);
    expect(getActiveWebListener("default")).toBeNull();
    const replacement = makeListener();
    const currentLease = registerListener("work", replacement);
    oldLease.dispose();
    expect(getActiveWebListener("work")).toBe(replacement);
    currentLease.dispose();
    expect(getActiveWebListener("work")).toBeNull();
    expect(getActiveWebListener("other")).toBe(otherListener);
  });

  it("returns null when the controller has no active listener for the account", () => {
    const lease = registerListener("work", null);
    expect(getActiveWebListener("work")).toBeNull();
    lease.dispose();
    expect(getActiveWebListener("work")).toBeNull();
  });
});
