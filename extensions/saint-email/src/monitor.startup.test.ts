import type { PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";
import { monitorSaintEmailProvider } from "./monitor.js";
import { setSaintEmailRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  gmailListMessages: vi.fn(),
  gmailGetMessage: vi.fn(),
  gmailGetAttachment: vi.fn(),
  handleSaintEmailInbound: vi.fn(),
}));

vi.mock("./gmail-api.js", () => ({
  gmailListMessages: mocks.gmailListMessages,
  gmailGetMessage: mocks.gmailGetMessage,
  gmailGetAttachment: mocks.gmailGetAttachment,
  decodeBase64Url: (value: string) => {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf-8");
  },
  decodeBase64UrlToBuffer: (value: string) => {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64");
  },
}));

vi.mock("./inbound.js", () => ({
  handleSaintEmailInbound: mocks.handleSaintEmailInbound,
}));

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function waitFor(fn: () => void, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fn();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  fn();
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.gmailListMessages.mockReset();
  mocks.gmailGetMessage.mockReset();
  mocks.gmailGetAttachment.mockReset();
  mocks.handleSaintEmailInbound.mockReset();
});

describe("monitorSaintEmailProvider startup behavior", () => {
  it("processes unseen messages on first poll", async () => {
    setSaintEmailRuntime({
      logging: {
        getChildLogger: () => ({
          warn: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        }),
      },
      channel: {
        media: {
          saveMediaBuffer: vi.fn(async (buffer: Buffer) => ({
            path: `/tmp/${buffer.byteLength}.bin`,
            contentType: "application/octet-stream",
            id: "saved",
            size: buffer.byteLength,
          })),
        },
      },
    } as unknown as PluginRuntime);

    mocks.gmailListMessages.mockResolvedValue(["msg-1"]);
    mocks.gmailGetMessage.mockResolvedValue({
      id: "msg-1",
      threadId: "thread-1",
      internalDate: "1700000000000",
      payload: {
        headers: [
          { name: "From", value: "Client <client@example.com>" },
          { name: "To", value: "bot@example.com" },
          { name: "Subject", value: "Hello" },
        ],
        mimeType: "text/plain",
        body: { data: encodeBase64Url("hello team") },
      },
      snippet: "hello team",
    });
    mocks.handleSaintEmailInbound.mockResolvedValue(undefined);

    const account = {
      accountId: "default",
      enabled: true,
      address: "bot@example.com",
      userId: "me",
      accessToken: "token",
      dmPolicy: "allowlist" as const,
      allowFrom: [],
      pollIntervalSec: 60,
      pollQuery: "in:inbox",
      maxPollResults: 10,
      maxAttachmentMb: 20,
    };

    const monitor = await monitorSaintEmailProvider({
      account,
      config: {} as CoreConfig,
      runtime: {} as RuntimeEnv,
    });
    try {
      await waitFor(() => {
        expect(mocks.handleSaintEmailInbound).toHaveBeenCalledTimes(1);
      });
    } finally {
      monitor.stop();
    }
  });

  it("downloads and forwards inbound attachments", async () => {
    const saveMediaBuffer = vi.fn(
      async (
        _buffer: Buffer,
        _contentType?: string,
        _subdir?: string,
        _maxBytes?: number,
        originalFilename?: string,
      ) => ({
        path: `/tmp/${originalFilename ?? "attachment.bin"}`,
        contentType: "application/pdf",
        id: "saved-att",
        size: 11,
      }),
    );
    setSaintEmailRuntime({
      logging: {
        getChildLogger: () => ({
          warn: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        }),
      },
      channel: {
        media: {
          saveMediaBuffer,
        },
      },
    } as unknown as PluginRuntime);

    mocks.gmailListMessages.mockResolvedValue(["msg-2"]);
    mocks.gmailGetAttachment.mockResolvedValue(Buffer.from("hello world", "utf-8"));
    mocks.gmailGetMessage.mockResolvedValue({
      id: "msg-2",
      threadId: "thread-2",
      internalDate: "1700000000000",
      payload: {
        headers: [
          { name: "From", value: "Client <client@example.com>" },
          { name: "To", value: "bot@example.com" },
          { name: "Subject", value: "Attachment only" },
        ],
        mimeType: "multipart/mixed",
        parts: [
          {
            filename: "report.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-42", size: 11 },
          },
        ],
      },
      snippet: "",
    });
    mocks.handleSaintEmailInbound.mockResolvedValue(undefined);

    const account = {
      accountId: "default",
      enabled: true,
      address: "bot@example.com",
      userId: "me",
      accessToken: "token",
      dmPolicy: "allowlist" as const,
      allowFrom: [],
      pollIntervalSec: 60,
      pollQuery: "in:inbox",
      maxPollResults: 10,
      maxAttachmentMb: 20,
    };

    const monitor = await monitorSaintEmailProvider({
      account,
      config: {} as CoreConfig,
      runtime: {} as RuntimeEnv,
    });
    try {
      await waitFor(() => {
        expect(mocks.gmailGetAttachment).toHaveBeenCalledTimes(1);
        expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
        expect(mocks.handleSaintEmailInbound).toHaveBeenCalledTimes(1);
      });
      const call = mocks.handleSaintEmailInbound.mock.calls[0]?.[0] as {
        message?: { attachments?: Array<{ path: string }> };
      };
      expect(call.message?.attachments?.[0]?.path).toBe("/tmp/report.pdf");
    } finally {
      monitor.stop();
    }
  });
});
