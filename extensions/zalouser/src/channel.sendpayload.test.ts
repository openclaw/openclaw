import type { ReplyPayload } from "openclaw/plugin-sdk/zalouser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkMarkdownText } from "../../../src/auto-reply/chunk.js";
import {
  installSendPayloadContractSuite,
  primeSendMock,
} from "../../../src/test-utils/send-payload-contract.js";
import { zalouserPlugin } from "./channel.js";
import { setZalouserRuntime } from "./runtime.js";

vi.mock("./send.js", () => ({
  sendMessageZalouser: vi.fn().mockResolvedValue({ ok: true, messageId: "zlu-1" }),
  sendReactionZalouser: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveZalouserAccountSync: () => ({
      accountId: "default",
      profile: "default",
      name: "test",
      enabled: true,
      config: {},
    }),
  };
});

function baseCtx(payload: ReplyPayload) {
  return {
    cfg: {},
    to: "user:987654321",
    text: "",
    payload,
  };
}

describe("zalouserPlugin outbound sendPayload", () => {
  let mockedSend: ReturnType<typeof vi.mocked<(typeof import("./send.js"))["sendMessageZalouser"]>>;

  beforeEach(async () => {
    setZalouserRuntime({
      channel: {
        text: {
          chunkMarkdownText,
        },
      },
    } as never);
    const mod = await import("./send.js");
    mockedSend = vi.mocked(mod.sendMessageZalouser);
    mockedSend.mockClear();
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-1" });
  });

  it("group target delegates with isGroup=true and stripped threadId", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-g1" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text: "hello group" }),
      to: "group:1471383327500481391",
    });

    expect(mockedSend).toHaveBeenCalledWith(
      "1471383327500481391",
      "hello group",
      expect.objectContaining({ isGroup: true, textMode: "markdown" }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-g1" });
  });

  it("treats bare numeric targets as direct chats for backward compatibility", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-d1" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text: "hello" }),
      to: "987654321",
    });

    expect(mockedSend).toHaveBeenCalledWith(
      "987654321",
      "hello",
      expect.objectContaining({ isGroup: false, textMode: "markdown" }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-d1" });
  });

  it("preserves provider-native group ids when sending to raw g- targets", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-g-native" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text: "hello native group" }),
      to: "g-1471383327500481391",
    });

    expect(mockedSend).toHaveBeenCalledWith(
      "g-1471383327500481391",
      "hello native group",
      expect.objectContaining({ isGroup: true, textMode: "markdown" }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-g-native" });
  });

  it("uses markdown-aware chunking for long fenced code payloads", async () => {
    const codeLine = "const value = 1234567890;";
    const text = `\`\`\`ts\n${Array.from({ length: 140 }, () => codeLine).join("\n")}\n\`\`\``;
    const expectedChunks = chunkMarkdownText(text, 2000);
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-code" });

    const result = await zalouserPlugin.outbound!.sendPayload!({
      ...baseCtx({ text }),
      to: "987654321",
    });

    expect(mockedSend.mock.calls.map((call) => call[1])).toEqual(expectedChunks);
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-code" });
  });

  installSendPayloadContractSuite({
    channel: "zalouser",
    chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
    createHarness: ({ payload, sendResults }) => {
      primeSendMock(mockedSend, { ok: true, messageId: "zlu-1" }, sendResults);
      return {
        run: async () => await zalouserPlugin.outbound!.sendPayload!(baseCtx(payload)),
        sendMock: mockedSend,
        to: "987654321",
      };
    },
  });
});

describe("zalouserPlugin messaging target normalization", () => {
  it("normalizes user/group aliases to canonical targets", () => {
    const normalize = zalouserPlugin.messaging?.normalizeTarget;
    expect(normalize).toBeTypeOf("function");
    if (!normalize) {
      return;
    }
    expect(normalize("zlu:g:30003")).toBe("group:30003");
    expect(normalize("zalouser:u:20002")).toBe("user:20002");
    expect(normalize("zlu:g-30003")).toBe("group:g-30003");
    expect(normalize("zalouser:u-20002")).toBe("user:u-20002");
    expect(normalize("20002")).toBe("20002");
  });

  it("treats canonical and provider-native user/group targets as ids", () => {
    const looksLikeId = zalouserPlugin.messaging?.targetResolver?.looksLikeId;
    expect(looksLikeId).toBeTypeOf("function");
    if (!looksLikeId) {
      return;
    }
    expect(looksLikeId("user:20002")).toBe(true);
    expect(looksLikeId("group:30003")).toBe(true);
    expect(looksLikeId("g-30003")).toBe(true);
    expect(looksLikeId("u-20002")).toBe(true);
    expect(looksLikeId("Alice Nguyen")).toBe(false);
  });
});
