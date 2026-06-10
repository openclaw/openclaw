// Signal tests cover send plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const signalRpcRequestMock = vi.hoisted(() =>
  vi.fn(async (_method?: unknown, _params?: unknown, _options?: unknown): Promise<unknown> => ({})),
);
const statMock = vi.hoisted(() => vi.fn(async () => ({ size: 4321 })));
const rememberSignalSelfReplyEchoMock = vi.hoisted(() => vi.fn());
const forgetSignalSelfReplyEchoMock = vi.hoisted(() => vi.fn());
const discoverSignalAccountUuidMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown): Promise<string | undefined> => undefined),
);
const appendSignalApprovalReactionHintMock = vi.hoisted(() =>
  vi.fn((params: { text: string }) => params.text),
);
const registerSignalApprovalReactionTargetMock = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrlMock = vi.hoisted(() =>
  vi.fn(
    async (_params: unknown): Promise<{ path: string; contentType?: string }> => ({
      path: "/tmp/image.png",
      contentType: "image/png",
    }),
  ),
);

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: Parameters<typeof signalRpcRequestMock>) =>
    signalRpcRequestMock(...args),
}));

vi.mock("./account-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./account-store.js")>();
  return {
    ...actual,
    discoverSignalAccountUuid: (...args: Parameters<typeof discoverSignalAccountUuidMock>) =>
      discoverSignalAccountUuidMock(...args),
  };
});

vi.mock("node:fs/promises", () => ({
  default: { stat: statMock },
}));

vi.mock("./self-reply-echoes.js", () => ({
  forgetSignalSelfReplyEcho: forgetSignalSelfReplyEchoMock,
  rememberSignalSelfReplyEcho: rememberSignalSelfReplyEchoMock,
  resolveSignalSelfReplyMediaEchoText: (params: {
    contentType?: string | null;
    size?: number | null;
  }) => {
    const contentType = params.contentType?.trim().toLowerCase();
    return contentType && params.size ? `<media:image:${contentType}:${params.size}>` : undefined;
  },
}));

vi.mock("./approval-reactions.js", () => ({
  appendSignalApprovalReactionHintForOutboundMessage: appendSignalApprovalReactionHintMock,
  extractSignalApprovalPromptBinding: (text: string) =>
    /\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(.+)$/im.test(text)
      ? { approvalId: "exec-1", allowedDecisions: ["allow-once", "deny"] }
      : null,
  registerSignalApprovalReactionTargetForOutboundMessage: registerSignalApprovalReactionTargetMock,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    resolveOutboundAttachmentFromUrl: (params: unknown) =>
      resolveOutboundAttachmentFromUrlMock(params),
  };
});

const { sendMessageSignal } = await import("./send.js");

const SIGNAL_TEST_CFG = {
  channels: {
    signal: {
      accounts: {
        default: {
          httpUrl: "http://signal.test",
          account: "+15550001111",
        },
      },
    },
  },
};

describe("sendMessageSignal receipts", () => {
  beforeEach(() => {
    signalRpcRequestMock.mockReset();
    statMock.mockReset().mockResolvedValue({ size: 4321 });
    rememberSignalSelfReplyEchoMock.mockReset();
    forgetSignalSelfReplyEchoMock.mockReset();
    discoverSignalAccountUuidMock.mockReset().mockResolvedValue(undefined);
    appendSignalApprovalReactionHintMock.mockClear();
    registerSignalApprovalReactionTargetMock.mockClear();
    resolveOutboundAttachmentFromUrlMock.mockClear();
  });

  it("attaches a text receipt for timestamp results", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567890 });

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(result.messageId).toBe("1234567890");
    expect(result.timestamp).toBe(1234567890);
    expect(result.receipt.primaryPlatformMessageId).toBe("1234567890");
    expect(result.receipt.platformMessageIds).toEqual(["1234567890"]);
    expect(result.receipt.raw).toEqual([
      {
        channel: "signal",
        messageId: "1234567890",
        toJid: "+15551234567",
        timestamp: 1234567890,
        meta: { targetType: "recipient" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "1234567890",
        kind: "text",
        raw: {
          channel: "signal",
          messageId: "1234567890",
          toJid: "+15551234567",
          timestamp: 1234567890,
          meta: { targetType: "recipient" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
    expect(discoverSignalAccountUuidMock).not.toHaveBeenCalled();
  });

  it("attaches a media receipt for attachment sends", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567891 });

    const result = await sendMessageSignal("group:group-1", "", {
      cfg: SIGNAL_TEST_CFG,
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalled();
    expect(result.messageId).toBe("1234567891");
    expect(result.timestamp).toBe(1234567891);
    expect(result.receipt.primaryPlatformMessageId).toBe("1234567891");
    expect(result.receipt.platformMessageIds).toEqual(["1234567891"]);
    expect(result.receipt.raw).toEqual([
      {
        channel: "signal",
        messageId: "1234567891",
        chatId: "group-1",
        timestamp: 1234567891,
        meta: { targetType: "group" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "1234567891",
        kind: "media",
        raw: {
          channel: "signal",
          messageId: "1234567891",
          chatId: "group-1",
          timestamp: 1234567891,
          meta: { targetType: "group" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
    expect(statMock).not.toHaveBeenCalled();
  });

  it("does not invent platform ids when signal-cli omits a timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({});

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(result.messageId).toBe("unknown");
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });

  it("records self-send echoes for note-to-self accounts", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567892 });

    await sendMessageSignal("+15550001111", "hello self", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
    });

    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "1234567892",
      timestamp: 1234567892,
      text: "hello self",
    });
    expect(forgetSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "unknown",
      text: "hello self",
    });
  });

  it("records text-only self-send echoes when signal-cli omits a timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({});
    appendSignalApprovalReactionHintMock.mockImplementationOnce(() => "actual sent body");

    await sendMessageSignal("+15550001111", "hello self without timestamp", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
    });

    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "unknown",
      timestamp: undefined,
      text: "actual sent body",
    });
  });

  it("keeps memory-only pre-send self-echo markers when Signal send is ambiguous", async () => {
    signalRpcRequestMock.mockRejectedValueOnce(new Error("Signal HTTP timed out after 30000ms"));

    await expect(
      sendMessageSignal("+15550001111", "hello failed self", {
        cfg: {
          channels: {
            signal: {
              accounts: {
                default: {
                  httpUrl: "http://signal.test",
                  account: "+15550001111",
                  ingressMode: "note-to-self",
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow("timed out");

    expect(forgetSignalSelfReplyEchoMock).not.toHaveBeenCalled();
  });

  it("clears memory-only pre-send self-echo markers when Signal send fails locally", async () => {
    signalRpcRequestMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:8080"));

    await expect(
      sendMessageSignal("+15550001111", "hello failed self", {
        cfg: {
          channels: {
            signal: {
              accounts: {
                default: {
                  httpUrl: "http://signal.test",
                  account: "+15550001111",
                  ingressMode: "note-to-self",
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow("ECONNREFUSED");

    expect(forgetSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "unknown",
      text: "hello failed self",
    });
  });

  it("clears memory-only pre-send self-echo markers when Signal REST send fails", async () => {
    signalRpcRequestMock.mockRejectedValueOnce(new Error("Signal REST 500: Internal Server Error"));

    await expect(
      sendMessageSignal("+15550001111", "hello rest failed self", {
        cfg: {
          channels: {
            signal: {
              accounts: {
                default: {
                  httpUrl: "http://signal.test",
                  account: "+15550001111",
                  ingressMode: "note-to-self",
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow("Signal REST 500");

    expect(forgetSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "unknown",
      text: "hello rest failed self",
    });
  });

  it("clears memory-only pre-send self-echo markers when Signal RPC send fails", async () => {
    signalRpcRequestMock.mockRejectedValueOnce(new Error("Signal RPC -32602: Invalid params"));

    await expect(
      sendMessageSignal("+15550001111", "hello rpc failed self", {
        cfg: {
          channels: {
            signal: {
              accounts: {
                default: {
                  httpUrl: "http://signal.test",
                  account: "+15550001111",
                  ingressMode: "note-to-self",
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow("Signal RPC -32602");

    expect(forgetSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "unknown",
      text: "hello rpc failed self",
    });
  });

  it("keeps memory-only pre-send self-echo markers when Signal REST send returns an invalid timestamp", async () => {
    signalRpcRequestMock.mockRejectedValueOnce(
      new Error("Signal REST send returned invalid timestamp"),
    );

    await expect(
      sendMessageSignal("+15550001111", "hello invalid timestamp", {
        cfg: {
          channels: {
            signal: {
              accounts: {
                default: {
                  httpUrl: "http://signal.test",
                  account: "+15550001111",
                  ingressMode: "note-to-self",
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow("Signal REST send returned invalid timestamp");

    expect(forgetSignalSelfReplyEchoMock).not.toHaveBeenCalled();
    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "unknown",
      text: "hello invalid timestamp",
    });
  });

  it("keeps memory-only pre-send self-echo markers when response loss is ambiguous", async () => {
    signalRpcRequestMock.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(
      sendMessageSignal("+15550001111", "hello ambiguous self", {
        cfg: {
          channels: {
            signal: {
              accounts: {
                default: {
                  httpUrl: "http://signal.test",
                  account: "+15550001111",
                  ingressMode: "note-to-self",
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow("socket hang up");

    expect(forgetSignalSelfReplyEchoMock).not.toHaveBeenCalled();
  });

  it("records exact attachment metadata for timestamp-less media-only self sends", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({});

    await sendMessageSignal("+15550001111", "", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "unknown",
      timestamp: undefined,
      text: "<media:image:image/png:4321>",
    });
    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "unknown",
      timestamp: undefined,
      text: "<media:image>",
    });
  });

  it("keeps exact and generic media echoes for timestamped self sends", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1700000000100 });

    await sendMessageSignal("+15550001111", "", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "1700000000100",
      timestamp: 1700000000100,
      text: "<media:image:image/png:4321>",
    });
    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "1700000000100",
      timestamp: 1700000000100,
      text: "<media:image>",
    });
  });

  it("records generic attachment echoes for timestamp-less media-only self sends without detected MIME", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({});
    resolveOutboundAttachmentFromUrlMock.mockResolvedValueOnce({ path: "/tmp/upload.bin" });

    await sendMessageSignal("+15550001111", "", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
      mediaUrl: "/tmp/upload.bin",
      mediaLocalRoots: ["/tmp"],
    });

    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "unknown",
      timestamp: undefined,
      text: "<media:attachment>",
    });
  });

  it("records UUID-addressed self-send echoes for note-to-self accounts", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567893 });

    await sendMessageSignal("uuid:123e4567-e89b-12d3-a456-426614174000", "hello uuid self", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                accountUuid: "123E4567-E89B-12D3-A456-426614174000",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
    });

    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith({
      accountId: "default",
      accountIdentity: "123E4567-E89B-12D3-A456-426614174000",
      messageId: "1234567893",
      timestamp: 1234567893,
      text: "hello uuid self",
    });
  });

  it("matches compact UUID self targets against canonical account UUIDs", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567896 });

    await sendMessageSignal("uuid:123e4567e89b12d3a456426614174000", "hello compact self", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                accountUuid: "123e4567-e89b-12d3-a456-426614174000",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
    });

    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "1234567896",
        text: "hello compact self",
      }),
    );
  });

  it("uses the discovered account UUID for note-to-self self-target detection", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567897 });
    discoverSignalAccountUuidMock.mockResolvedValueOnce("123e4567-e89b-12d3-a456-426614174000");

    await sendMessageSignal("uuid:123e4567-e89b-12d3-a456-426614174000", "hello discovered self", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
    });

    expect(discoverSignalAccountUuidMock).toHaveBeenCalledWith({
      account: "+15550001111",
      configPath: undefined,
    });
    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdentity: "123e4567-e89b-12d3-a456-426614174000",
        messageId: "1234567897",
        text: "hello discovered self",
      }),
    );
    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdentity: "+15550001111",
        messageId: "1234567897",
        text: "hello discovered self",
      }),
    );
  });

  it("does not discover the account UUID for external phone recipients", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567897 });

    await sendMessageSignal("+15550002222", "hello external", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
    });

    expect(discoverSignalAccountUuidMock).not.toHaveBeenCalled();
    expect(rememberSignalSelfReplyEchoMock).not.toHaveBeenCalled();
  });

  it("uses a supplied account UUID for note-to-self self-target detection", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567898 });

    await sendMessageSignal("uuid:123e4567-e89b-12d3-a456-426614174000", "hello resolved self", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
      accountUuid: "123E4567-E89B-12D3-A456-426614174000",
    });

    expect(discoverSignalAccountUuidMock).not.toHaveBeenCalled();
    expect(rememberSignalSelfReplyEchoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdentity: "123E4567-E89B-12D3-A456-426614174000",
        messageId: "1234567898",
        text: "hello resolved self",
      }),
    );
  });

  it("does not record non-self phone recipients for UUID-only note-to-self accounts", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567894 });

    await sendMessageSignal("+15550002222", "hello external", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                accountUuid: "123E4567-E89B-12D3-A456-426614174000",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
    });

    expect(rememberSignalSelfReplyEchoMock).not.toHaveBeenCalled();
  });

  it("binds approval reaction targets for note-to-self accounts with UUIDs", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567895 });

    await sendMessageSignal("+15550001111", "approval needed", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                accountUuid: "123E4567-E89B-12D3-A456-426614174000",
                ingressMode: "note-to-self",
              },
            },
          },
        },
      },
    });

    expect(appendSignalApprovalReactionHintMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAuthor: "+15550001111",
        targetAuthorUuid: "123E4567-E89B-12D3-A456-426614174000",
      }),
    );
    expect(registerSignalApprovalReactionTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAuthor: "+15550001111",
        targetAuthorUuid: "123E4567-E89B-12D3-A456-426614174000",
      }),
    );
    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ account: "+15550001111" }),
      expect.any(Object),
    );
  });

  it("discovers the account UUID for outbound approval prompts", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567899 });
    discoverSignalAccountUuidMock.mockResolvedValueOnce("123e4567-e89b-12d3-a456-426614174000");

    await sendMessageSignal("+15550002222", "/approve exec-1 allow-once deny", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                configPath: "/tmp/signal-cli",
              },
            },
          },
        },
      },
    });

    expect(discoverSignalAccountUuidMock).toHaveBeenCalledWith({
      account: "+15550001111",
      configPath: "/tmp/signal-cli",
    });
    expect(appendSignalApprovalReactionHintMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAuthor: "+15550001111",
        targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
      }),
    );
    expect(registerSignalApprovalReactionTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAuthor: "+15550001111",
        targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
      }),
    );
  });

  it("discovers the account UUID for outbound approval prompts sent from an override account", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567800 });
    discoverSignalAccountUuidMock.mockResolvedValueOnce("999e4567-e89b-12d3-a456-426614174999");

    await sendMessageSignal("+15550002222", "/approve exec-1 allow-once deny", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                accountUuid: "123e4567-e89b-12d3-a456-426614174000",
                configPath: "/tmp/signal-cli",
              },
            },
          },
        },
      },
      account: "+15550009999",
    });

    expect(discoverSignalAccountUuidMock).toHaveBeenCalledWith({
      account: "+15550009999",
      configPath: "/tmp/signal-cli",
    });
    expect(appendSignalApprovalReactionHintMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAuthor: "+15550009999",
        targetAuthorUuid: "999e4567-e89b-12d3-a456-426614174999",
      }),
    );
    expect(registerSignalApprovalReactionTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAuthor: "+15550009999",
        targetAuthorUuid: "999e4567-e89b-12d3-a456-426614174999",
      }),
    );
  });

  it("uses the runtime configPath override when discovering the account UUID", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567801 });
    discoverSignalAccountUuidMock.mockResolvedValueOnce("999e4567-e89b-12d3-a456-426614174999");

    await sendMessageSignal("+15550002222", "/approve exec-1 allow-once deny", {
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                httpUrl: "http://signal.test",
                account: "+15550001111",
                configPath: "/tmp/configured-signal-cli",
              },
            },
          },
        },
      },
      configPath: "/tmp/runtime-signal-cli",
    });

    expect(discoverSignalAccountUuidMock).toHaveBeenCalledWith({
      account: "+15550001111",
      configPath: "/tmp/runtime-signal-cli",
    });
    expect(appendSignalApprovalReactionHintMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAuthorUuid: "999e4567-e89b-12d3-a456-426614174999",
      }),
    );
  });
});
