import type { ResolvedChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { describe, expect, it, vi } from "vitest";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";

const { upsertPairingRequestMock } = vi.hoisted(() => ({ upsertPairingRequestMock: vi.fn() }));
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  upsertChannelPairingRequest: upsertPairingRequestMock,
}));

const TEST_ACCOUNT_ID = "default";
const TEST_SENDER = { id: "123", tag: "alice#0001", name: "alice" };

async function runDecision(
  decision: ResolvedChannelMessageIngress["senderAccess"]["decision"],
  pairingCreated = true,
) {
  upsertPairingRequestMock
    .mockReset()
    .mockResolvedValue({ code: "PAIR-1", created: pairingCreated });
  const harness = {
    onPairingCreated: vi.fn(async () => {}),
    onUnauthorized: vi.fn(async () => {}),
  };
  await handleDiscordDmCommandDecision({
    senderAccess: { decision },
    accountId: TEST_ACCOUNT_ID,
    sender: TEST_SENDER,
    ...harness,
  });
  return { ...harness, upsertPairingRequest: upsertPairingRequestMock };
}

describe("handleDiscordDmCommandDecision", () => {
  it("creates pairing reply for new pairing requests", async () => {
    const { onPairingCreated, onUnauthorized, upsertPairingRequest } = await runDecision("pairing");

    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "discord",
      id: "123",
      accountId: TEST_ACCOUNT_ID,
      meta: {
        tag: TEST_SENDER.tag,
        name: TEST_SENDER.name,
      },
    });
    expect(onPairingCreated).toHaveBeenCalledWith("PAIR-1");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("skips pairing reply when pairing request already exists", async () => {
    const { onPairingCreated, onUnauthorized } = await runDecision("pairing", false);

    expect(onPairingCreated).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("runs unauthorized handler for blocked DM access", async () => {
    const { onPairingCreated, onUnauthorized, upsertPairingRequest } = await runDecision("block");

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(onPairingCreated).not.toHaveBeenCalled();
  });
});
