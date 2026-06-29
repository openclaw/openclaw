import { beforeEach, describe, expect, it, vi } from "vitest";

const { openLocalFileMock, resolveLocalPathFromRootsSyncMock, sendMediaMock } = vi.hoisted(() => ({
  openLocalFileMock: vi.fn(),
  resolveLocalPathFromRootsSyncMock: vi.fn(),
  sendMediaMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolveLocalPathFromRootsSync: resolveLocalPathFromRootsSyncMock,
}));

vi.mock("./media-source.js", () => ({
  openLocalFile: openLocalFileMock,
}));

vi.mock("./sender.js", () => ({
  accountToCreds: (account: { appId: string; clientSecret: string }) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  buildDeliveryTarget: (target: { type: string; senderId: string; groupOpenid?: string }) => ({
    type: target.type === "group" ? "group" : target.type === "c2c" ? "c2c" : target.type,
    id: target.type === "group" ? target.groupOpenid : target.senderId,
  }),
  sendMedia: sendMediaMock,
  sendText: vi.fn(),
  withTokenRetry: async (_creds: unknown, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock("./trusted-media-path.js", () => ({
  resolveTrustedOutboundMediaPath: vi.fn(() => null),
}));

import { handleStructuredPayload } from "./reply-dispatcher.js";

function makeReplyContext() {
  return {
    target: {
      type: "c2c" as const,
      senderId: "user-openid",
      messageId: "msg-1",
    },
    account: {
      accountId: "qq-main",
      appId: "app-x",
      clientSecret: "secret-x",
      markdownSupport: false,
      config: {},
    },
    cfg: {},
    mediaAccess: {
      localRoots: ["/workspace/attachments"],
      workspaceDir: "/tmp/agent-workspace",
    },
    mediaLocalRoots: ["/workspace/attachments"],
    log: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe("handleStructuredPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openLocalFileMock.mockResolvedValue({
      size: 12,
      handle: { readFile: vi.fn() },
      close: vi.fn(),
    });
    sendMediaMock.mockResolvedValue({ id: "media-1", timestamp: 123 });
    resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
      filePath === "/workspace/attachments/report.pdf"
        ? { path: "/workspace/attachments/report.pdf" }
        : null,
    );
  });

  it("preserves authorized host /workspace paths before virtual workspace mapping", async () => {
    const handled = await handleStructuredPayload(
      makeReplyContext(),
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "file",
        source: "file",
        path: "/workspace/attachments/report.pdf",
      })}`,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(resolveLocalPathFromRootsSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/workspace/attachments/report.pdf",
        roots: ["/workspace/attachments", "/tmp/agent-workspace"],
      }),
    );
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        source: { localPath: "/workspace/attachments/report.pdf" },
      }),
    );
  });

  it("resolves relative payload paths only against the virtual workspace", async () => {
    resolveLocalPathFromRootsSyncMock.mockImplementation(({ filePath }: { filePath: string }) =>
      filePath === "/tmp/agent-workspace/report.pdf"
        ? { path: "/tmp/agent-workspace/report.pdf" }
        : null,
    );

    const handled = await handleStructuredPayload(
      makeReplyContext(),
      `QQBOT_PAYLOAD:${JSON.stringify({
        type: "media",
        mediaType: "file",
        source: "file",
        path: "report.pdf",
      })}`,
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(resolveLocalPathFromRootsSyncMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "report.pdf" }),
    );
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        source: { localPath: "/tmp/agent-workspace/report.pdf" },
      }),
    );
  });
});
