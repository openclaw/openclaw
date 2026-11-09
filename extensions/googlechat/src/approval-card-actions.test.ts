import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  googleChatApprovalControls,
  registerGoogleChatManualApprovalFollowupSuppression as registerGoogleChatManualApprovalFollowupSuppressionRaw,
  registerGoogleChatApprovalCardBinding as registerGoogleChatApprovalCardBindingRaw,
  shouldSuppressGoogleChatManualExecApprovalFollowupPayload as suppressesPayload,
  shouldSuppressGoogleChatManualExecApprovalFollowupText as suppressesText,
  unregisterGoogleChatManualApprovalFollowupSuppression,
} from "./approval-card-actions.js";

const approvalId = "12345678-1234-1234-1234-123456789012";
let tokenCounter = 0;
const registeredTokens = new Set<string>();
const registeredApprovalIds = new Set<string>();
const suppressionDefaults = {
  approvalKind: "exec" as const,
  allowedDecisions: ["allow-once", "deny"] as const,
};
const command = (id = approvalId.slice(0, 8)) => `/approve ${id} allow-once`;

function registerExecApprovalCard(
  overrides: Partial<Parameters<typeof registerGoogleChatApprovalCardBindingRaw>[0]> = {},
): void {
  const binding = {
    ...suppressionDefaults,
    token: `token-${tokenCounter++}`,
    accountId: "default",
    approvalId,
    decision: "allow-once" as const,
    spaceName: "spaces/AAA",
    messageName: "spaces/AAA/messages/msg-1",
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
  registeredTokens.add(binding.token);
  registeredApprovalIds.add(binding.approvalId);
  registerGoogleChatApprovalCardBindingRaw(binding);
}

function registerGoogleChatManualApprovalFollowupSuppression(id: string): boolean {
  registeredApprovalIds.add(id);
  return registerGoogleChatManualApprovalFollowupSuppressionRaw({
    ...suppressionDefaults,
    approvalId: id,
    expiresAtMs: Date.now() + 60_000,
  });
}

describe("Google Chat approval card action registry", () => {
  afterEach(() => {
    googleChatApprovalControls.unregister([...registeredTokens]);
    for (const registeredApprovalId of registeredApprovalIds) {
      unregisterGoogleChatManualApprovalFollowupSuppression(registeredApprovalId);
    }
    registeredTokens.clear();
    registeredApprovalIds.clear();
  });

  it("suppresses manual exec approval follow-up text for an active native card", () => {
    registerExecApprovalCard();

    expect(
      suppressesText(
        `I need approval.\nReply with:\n/approve ${approvalId.slice(0, 8)} allow-once`,
      ),
    ).toBe(true);
    expect(suppressesText(`Run this if needed: \`/approve ${approvalId} deny\``)).toBe(true);
  });

  it("keeps unrelated, expired, and non-sendable approval text visible", () => {
    registerExecApprovalCard({ expiresAtMs: Date.now() - 1 });
    expect(suppressesText(command())).toBe(false);

    registerExecApprovalCard();
    expect(suppressesText(command("deadbeef"))).toBe(false);
    expect(suppressesText(`/approve ${approvalId} nope`)).toBe(false);
  });

  it("suppresses plugin approval follow-ups only for the matching card and allowed decision", () => {
    const pluginApprovalId = `plugin:${approvalId}`;
    registerExecApprovalCard({ approvalId: pluginApprovalId, approvalKind: "plugin" });

    expect(suppressesText(`Please approve: /approve ${pluginApprovalId} allow-once`)).toBe(true);
    expect(suppressesText(`/approve plugin:${approvalId.slice(0, 8)} deny`)).toBe(true);
    for (const manualCommand of [
      `/approve ${approvalId} allow-once`,
      `/approve plugin:deadbeef allow-once`,
      `/approve ${pluginApprovalId} allow-always`,
    ]) {
      expect(suppressesText(manualCommand)).toBe(false);
    }
    expect(suppressesText(`/approve ${pluginApprovalId} allow-once`, Date.now() + 60_001)).toBe(
      false,
    );
  });

  it.each<{ extra: ReplyPayload; suppressed: boolean }>([
    { extra: {}, suppressed: true },
    { extra: { mediaUrl: "https://example.test/image.png" }, suppressed: false },
    { extra: { channelData: { execApproval: { approvalId } } }, suppressed: true },
    { extra: { presentation: { blocks: [] } }, suppressed: false },
  ])("suppresses manual approval payload %j", ({ extra, suppressed }) => {
    registerExecApprovalCard();
    expect(suppressesPayload({ text: command(), ...extra })).toBe(suppressed);
  });

  it("evicts oldest approval card bindings once the cache exceeds its cap", () => {
    const firstToken = "token-first";
    registerExecApprovalCard({
      token: firstToken,
      approvalId: "approval-first",
    });
    expect(googleChatApprovalControls.get(firstToken)).not.toBeNull();

    for (let i = 1; i <= 1024; i += 1) {
      registerExecApprovalCard({
        token: `token-fill-${i}`,
        approvalId: `approval-fill-${i}`,
        messageName: `spaces/AAA/messages/msg-${i}`,
      });
    }

    expect(googleChatApprovalControls.get(firstToken)).toBeNull();
    expect(googleChatApprovalControls.get("token-fill-1024")).not.toBeNull();
  });

  it("evicts oldest manual approval follow-up suppressions once the cache exceeds its cap", () => {
    const firstApprovalId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    registerGoogleChatManualApprovalFollowupSuppression(firstApprovalId);
    expect(suppressesText(command(firstApprovalId.slice(0, 8)))).toBe(true);

    for (let i = 1; i <= 1024; i += 1) {
      registerGoogleChatManualApprovalFollowupSuppression(
        `${i.toString().padStart(8, "0")}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
      );
    }

    expect(suppressesText(command(firstApprovalId.slice(0, 8)))).toBe(false);
    expect(suppressesText(command("1024".padStart(8, "0")))).toBe(true);
  });
});
