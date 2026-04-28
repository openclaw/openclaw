import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendMessageMatrix: vi.fn(),
  sendPollMatrix: vi.fn(),
}));

vi.mock("./matrix/send.js", () => ({
  sendMessageMatrix: mocks.sendMessageMatrix,
  sendPollMatrix: mocks.sendPollMatrix,
}));

vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

import { matrixOutbound } from "./outbound.js";

describe("matrixOutbound cfg threading", () => {
  beforeEach(() => {
    mocks.sendMessageMatrix.mockReset();
    mocks.sendPollMatrix.mockReset();
    mocks.sendMessageMatrix.mockResolvedValue({ messageId: "evt-1", roomId: "!room:example" });
    mocks.sendPollMatrix.mockResolvedValue({ eventId: "$poll", roomId: "!room:example" });
  });

  it("chunks outbound text without requiring Matrix runtime initialization", () => {
    const chunker = matrixOutbound.chunker;
    if (!chunker) {
      throw new Error("matrixOutbound.chunker missing");
    }

    expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
  });

  it("passes resolved cfg to sendMessageMatrix for text sends", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendText!({
      cfg,
      to: "room:!room:example",
      text: "hello",
      accountId: "default",
      threadId: "$thread",
      replyToId: "$reply",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room:example",
      "hello",
      expect.objectContaining({
        cfg,
        accountId: "default",
        threadId: "$thread",
        replyToId: "$reply",
      }),
    );
  });

  it("passes resolved cfg to sendMessageMatrix for media sends", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendMedia!({
      cfg,
      to: "room:!room:example",
      text: "caption",
      mediaUrl: "file:///tmp/cat.png",
      mediaLocalRoots: ["/tmp/openclaw"],
      accountId: "default",
      audioAsVoice: true,
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room:example",
      "caption",
      expect.objectContaining({
        cfg,
        mediaUrl: "file:///tmp/cat.png",
        mediaLocalRoots: ["/tmp/openclaw"],
        audioAsVoice: true,
      }),
    );
  });

  it("passes resolved cfg through injected deps.matrix", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;
    const matrix = vi.fn(async () => ({
      messageId: "evt-injected",
      roomId: "!room:example",
    }));

    await matrixOutbound.sendText!({
      cfg,
      to: "room:!room:example",
      text: "hello via deps",
      deps: { matrix },
      accountId: "default",
      threadId: "$thread",
      replyToId: "$reply",
    });

    expect(matrix).toHaveBeenCalledWith(
      "room:!room:example",
      "hello via deps",
      expect.objectContaining({
        cfg,
        accountId: "default",
        threadId: "$thread",
        replyToId: "$reply",
      }),
    );
  });

  it("passes resolved cfg to sendPollMatrix", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    await matrixOutbound.sendPoll!({
      cfg,
      to: "room:!room:example",
      poll: {
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      },
      accountId: "default",
      threadId: "$thread",
    });

    expect(mocks.sendPollMatrix).toHaveBeenCalledWith(
      "room:!room:example",
      expect.objectContaining({
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      }),
      expect.objectContaining({
        cfg,
        accountId: "default",
        threadId: "$thread",
      }),
    );
  });

  it("renders MessagePresentation into Matrix custom content metadata", async () => {
    const presentation = {
      title: "Select thinking level",
      tone: "info" as const,
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            { label: "Low", value: "/think low" },
            { label: "High", value: "/think high", style: "primary" as const },
          ],
        },
      ],
    };

    const rendered = await matrixOutbound.renderPresentation!({
      payload: { text: "fallback", presentation },
      presentation,
      ctx: {} as never,
    });

    const matrixData =
      (rendered?.channelData?.matrix as {
        extraContent?: Record<string, unknown>;
      }) ?? {};
    expect(rendered?.text).toContain("fallback");
    expect(rendered?.text).toContain("Select thinking level");
    expect(matrixData.extraContent?.["com.openclaw.presentation"]).toEqual({
      version: 1,
      ...presentation,
    });
  });

  it("passes Matrix presentation metadata through sendPayload extraContent", async () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "resolved-token",
        },
      },
    } as OpenClawConfig;

    const presentationContent = {
      version: 1,
      title: "Select model",
      blocks: [
        {
          type: "select",
          placeholder: "Choose model",
          options: [{ label: "DeepSeek", value: "/model deepseek/deepseek-chat" }],
        },
      ],
    };

    await matrixOutbound.sendPayload!({
      cfg,
      to: "room:!room:example",
      text: "Select model",
      payload: {
        text: "Select model",
        channelData: {
          matrix: {
            extraContent: {
              "com.openclaw.presentation": presentationContent,
            },
          },
        },
      },
      accountId: "default",
      threadId: "$thread",
      replyToId: "$reply",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room:example",
      "Select model",
      expect.objectContaining({
        cfg,
        accountId: "default",
        threadId: "$thread",
        replyToId: "$reply",
        extraContent: {
          "com.openclaw.presentation": presentationContent,
        },
      }),
    );
  });
});
