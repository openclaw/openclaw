import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInboundDecisionParams } from "./inbound-decision.test-support.js";
import { readIMessageInboundStoreAllowFrom } from "./pairing-store-admission.js";

const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => ["+15555550999"]));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore:
      readChannelAllowFromStoreMock as typeof actual.readChannelAllowFromStore,
  };
});

describe("readIMessageInboundStoreAllowFrom", () => {
  beforeEach(() => {
    readChannelAllowFromStoreMock.mockClear();
    readChannelAllowFromStoreMock.mockResolvedValue(["+15555550999"]);
  });

  it("skips the store for configured allowFrom senders", async () => {
    const params = createInboundDecisionParams({
      allowFrom: ["+15555550123"],
      dmPolicy: "pairing",
    });
    await expect(
      readIMessageInboundStoreAllowFrom({
        message: params.message,
        cfg: params.cfg,
        accountId: params.accountId,
        dmPolicy: params.dmPolicy,
        groupAllowFrom: params.groupAllowFrom,
        allowFrom: params.allowFrom,
      }),
    ).resolves.toEqual([]);
    expect(readChannelAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("reads the store for unpaired pairing-policy DMs", async () => {
    const params = createInboundDecisionParams({
      allowFrom: [],
      dmPolicy: "pairing",
    });
    await expect(
      readIMessageInboundStoreAllowFrom({
        message: params.message,
        cfg: params.cfg,
        accountId: params.accountId,
        dmPolicy: params.dmPolicy,
        groupAllowFrom: params.groupAllowFrom,
        allowFrom: params.allowFrom,
      }),
    ).resolves.toEqual(["+15555550999"]);
    expect(readChannelAllowFromStoreMock).toHaveBeenCalledOnce();
  });

  it("propagates store read failures for unpaired pairing-policy DMs", async () => {
    readChannelAllowFromStoreMock.mockRejectedValueOnce(new Error("pairing store unavailable"));
    const params = createInboundDecisionParams({
      allowFrom: [],
      dmPolicy: "pairing",
    });
    await expect(
      readIMessageInboundStoreAllowFrom({
        message: params.message,
        cfg: params.cfg,
        accountId: params.accountId,
        dmPolicy: params.dmPolicy,
        groupAllowFrom: params.groupAllowFrom,
        allowFrom: params.allowFrom,
      }),
    ).rejects.toThrow("pairing store unavailable");
  });
});
