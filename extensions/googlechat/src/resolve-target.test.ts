import { beforeEach, describe, expect, it, vi } from "vitest";
import { installCommonResolveTargetErrorCases } from "../../shared/resolve-target-test-helpers.js";

const runtimeMocks = vi.hoisted(() => ({
  chunkMarkdownText: vi.fn((text: string) => [text]),
  fetchRemoteMedia: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/googlechat", () => ({
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
      text: { chunkMarkdownText: runtimeMocks.chunkMarkdownText },
      media: { fetchRemoteMedia: runtimeMocks.fetchRemoteMedia },
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

import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/googlechat";
import { resolveGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage, uploadGoogleChatAttachment } from "./api.js";
import { googlechatPlugin } from "./channel.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const resolveTarget = googlechatPlugin.outbound!.resolveTarget!;

describe("googlechat resolveTarget", () => {
  it("should resolve valid target", () => {
    const result = resolveTarget({
      to: "spaces/AAA",
      mode: "explicit",
      allowFrom: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("spaces/AAA");
  });

  it("should resolve email target", () => {
    const result = resolveTarget({
      to: "user@example.com",
      mode: "explicit",
      allowFrom: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("users/user@example.com");
  });

  installCommonResolveTargetErrorCases({
    resolveTarget,
    implicitAllowFrom: ["spaces/BBB"],
  });
});

describe("googlechat outbound cfg threading", () => {
  beforeEach(() => {
    runtimeMocks.fetchRemoteMedia.mockReset();
    runtimeMocks.chunkMarkdownText.mockClear();
    vi.mocked(resolveGoogleChatAccount).mockReset();
    vi.mocked(resolveGoogleChatOutboundSpace).mockReset();
    vi.mocked(resolveChannelMediaMaxBytes).mockReset();
    vi.mocked(uploadGoogleChatAttachment).mockReset();
    vi.mocked(sendGoogleChatMessage).mockReset();
  });

  it("threads resolved cfg into sendText account resolution", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: {
            type: "service_account",
          },
        },
      },
    };
    const account = {
      accountId: "default",
      config: {},
      credentialSource: "inline",
    };
    vi.mocked(resolveGoogleChatAccount).mockReturnValue(account as any);
    vi.mocked(resolveGoogleChatOutboundSpace).mockResolvedValue("spaces/AAA");
    vi.mocked(sendGoogleChatMessage).mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    } as any);

    await googlechatPlugin.outbound!.sendText!({
      cfg: cfg as any,
      to: "users/123",
      text: "hello",
      accountId: "default",
    });

    expect(resolveGoogleChatAccount).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
    });
    expect(sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/AAA",
        text: "hello",
      }),
    );
  });

  it("threads resolved cfg into sendMedia account and media loading path", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: {
            type: "service_account",
          },
          mediaMaxMb: 8,
        },
      },
    };
    const account = {
      accountId: "default",
      config: { mediaMaxMb: 20 },
      credentialSource: "inline",
    };
    vi.mocked(resolveGoogleChatAccount).mockReturnValue(account as any);
    vi.mocked(resolveGoogleChatOutboundSpace).mockResolvedValue("spaces/AAA");
    vi.mocked(resolveChannelMediaMaxBytes).mockReturnValue(1024);
    runtimeMocks.fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("file"),
      fileName: "file.png",
      contentType: "image/png",
    });
    vi.mocked(uploadGoogleChatAttachment).mockResolvedValue({
      attachmentUploadToken: "token-1",
    } as any);
    vi.mocked(sendGoogleChatMessage).mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-2",
    } as any);

    await googlechatPlugin.outbound!.sendMedia!({
      cfg: cfg as any,
      to: "users/123",
      text: "photo",
      mediaUrl: "https://example.com/file.png",
      accountId: "default",
    });

    expect(resolveGoogleChatAccount).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
    });
    expect(runtimeMocks.fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://example.com/file.png",
      maxBytes: 1024,
    });
    expect(uploadGoogleChatAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        space: "spaces/AAA",
        filename: "file.png",
      }),
    );
    expect(sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        attachments: [{ attachmentUploadToken: "token-1", contentName: "file.png" }],
      }),
    );
  });
});
