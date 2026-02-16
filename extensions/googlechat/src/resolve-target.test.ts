import { describe, expect, it, vi } from "vitest";
import { installCommonResolveTargetErrorCases } from "../../shared/resolve-target-test-helpers.js";

vi.mock("openclaw/plugin-sdk", () => ({
  getChatChannelMeta: () => ({ id: "googlechat", label: "Google Chat" }),
  missingTargetError: (provider: string, hint: string) =>
    new Error(`Delivering to ${provider} requires target ${hint}`),
  GoogleChatConfigSchema: {},
  DEFAULT_ACCOUNT_ID: "default",
  PAIRING_APPROVED_MESSAGE: "Approved",
  applyAccountNameToChannelSection: vi.fn(),
  buildChannelConfigSchema: vi.fn(),
  deleteAccountFromConfigSection: vi.fn(),
  formatPairingApproveHint: vi.fn(),
  migrateBaseNameToDefaultAccount: vi.fn(),
  normalizeAccountId: vi.fn(),
  resolveChannelMediaMaxBytes: vi.fn(),
  resolveGoogleChatGroupRequireMention: vi.fn(),
  setAccountEnabledInConfigSection: vi.fn(),
}));

vi.mock("./accounts.js", () => ({
  listGoogleChatAccountIds: vi.fn(),
  resolveDefaultGoogleChatAccountId: vi.fn(),
  resolveGoogleChatAccount: vi.fn(),
}));

vi.mock("./actions.js", () => ({
  googlechatMessageActions: [],
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage: vi.fn(),
  uploadGoogleChatAttachment: vi.fn(),
  probeGoogleChat: vi.fn(),
}));

vi.mock("./monitor.js", () => ({
  resolveGoogleChatWebhookPath: vi.fn(),
  startGoogleChatMonitor: vi.fn(),
}));

vi.mock("./onboarding.js", () => ({
  googlechatOnboardingAdapter: {},
}));

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime: vi.fn(() => ({
    channel: {
      text: { chunkMarkdownText: vi.fn() },
    },
  })),
}));

vi.mock("./targets.js", () => ({
  normalizeGoogleChatTarget: (raw?: string | null) => {
    if (!raw?.trim()) return undefined;
    if (raw === "invalid-target") return undefined;
    const trimmed = raw.trim().replace(/^(googlechat|google-chat|gchat):/i, "");
    if (trimmed.startsWith("spaces/")) return trimmed;
    if (trimmed.includes("@")) return `users/${trimmed.toLowerCase()}`;
    return `users/${trimmed}`;
  },
  isGoogleChatUserTarget: (value: string) => value.startsWith("users/"),
  isGoogleChatSpaceTarget: (value: string) => value.startsWith("spaces/"),
  resolveGoogleChatOutboundSpace: vi.fn(),
}));

import { googlechatPlugin } from "./channel.js";

const resolveTarget = googlechatPlugin.outbound!.resolveTarget!;

describe("googlechat resolveTarget", () => {
  it("should resolve valid target", () => {
    const result = resolveTarget({
      to: "spaces/AAA",
      mode: "explicit",
      allowFrom: [],
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("spaces/AAA");
  });

  it("should resolve email target", () => {
    const result = resolveTarget({
      to: "user@example.com",
      mode: "explicit",
      allowFrom: [],
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("users/user@example.com");
  });

  installCommonResolveTargetErrorCases({
    resolveTarget,
    implicitAllowFrom: ["spaces/BBB"],
  });
});
