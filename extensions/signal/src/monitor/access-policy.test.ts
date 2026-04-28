import { describe, expect, it, vi } from "vitest";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>()),
  readStoreAllowFromForDmPolicy: vi.fn(async () => []),
}));

describe("handleSignalDirectMessageAccess", () => {
  it("returns true for already-allowed direct messages", async () => {
    await expect(
      handleSignalDirectMessageAccess({
        dmPolicy: "open",
        dmAccessDecision: "allow",
        senderId: "+15551230000",
        senderIdLine: "Signal number: +15551230000",
        senderDisplay: "Alice",
        accountId: "default",
        sendPairingReply: async () => {},
        log: () => {},
      }),
    ).resolves.toBe(true);
  });

  it("issues a pairing challenge for pairing-gated senders", async () => {
    const replies: string[] = [];
    const sendPairingReply = vi.fn(async (text: string) => {
      replies.push(text);
    });

    await expect(
      handleSignalDirectMessageAccess({
        dmPolicy: "pairing",
        dmAccessDecision: "pairing",
        senderId: "+15551230000",
        senderIdLine: "Signal number: +15551230000",
        senderDisplay: "Alice",
        senderName: "Alice",
        accountId: "default",
        sendPairingReply,
        log: () => {},
      }),
    ).resolves.toBe(false);

    expect(sendPairingReply).toHaveBeenCalledTimes(1);
    expect(replies[0]).toContain("Pairing code:");
  });
});

describe("resolveSignalAccessState (#53308 group id allowlist)", () => {
  const SENDER_PHONE = { kind: "phone" as const, e164: "+15555550100", raw: "+15555550100" };
  const GROUP_ID = "N69x7bHI51FBHwzVZrQ0qLrSxksI47o/DE2EUqihZtk=";

  it("allows a group message when groupAllowFrom contains the message's group id", async () => {
    const state = await resolveSignalAccessState({
      accountId: "default",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: [],
      // Operator config: list of base64 group ids — the documented format.
      groupAllowFrom: [GROUP_ID],
      sender: SENDER_PHONE,
      groupId: GROUP_ID,
    });

    const decision = state.resolveAccessDecision(true);
    expect(decision.decision).toBe("allow");
  });

  it("blocks a group message when groupAllowFrom does not contain the message's group id", async () => {
    const state = await resolveSignalAccessState({
      accountId: "default",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: ["someOtherGroupId="],
      sender: SENDER_PHONE,
      groupId: GROUP_ID,
    });

    const decision = state.resolveAccessDecision(true);
    expect(decision.decision).toBe("block");
  });

  it("still allows a group message when groupAllowFrom contains a sender identity that matches", async () => {
    // Backward-compat: existing groupAllowFrom configs that listed phones/UUIDs
    // (the previous, sender-shaped behavior) keep working.
    const state = await resolveSignalAccessState({
      accountId: "default",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: ["+15555550100"],
      sender: SENDER_PHONE,
      groupId: GROUP_ID,
    });

    const decision = state.resolveAccessDecision(true);
    expect(decision.decision).toBe("allow");
  });

  it("does not match groupId against the DM allowlist on direct messages", async () => {
    const state = await resolveSignalAccessState({
      accountId: "default",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      // DM allowFrom contains the same string the group id happens to be.
      // For a non-group inbound, we should still require a real sender match.
      allowFrom: [GROUP_ID],
      groupAllowFrom: [],
      sender: SENDER_PHONE,
      groupId: undefined,
    });

    const decision = state.resolveAccessDecision(false);
    expect(decision.decision).not.toBe("allow");
  });
});
