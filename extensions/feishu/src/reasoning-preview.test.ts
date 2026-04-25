import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";
import type { ClawdbotConfig } from "./bot-runtime-api.js";

const { loadSessionStoreMock } = vi.hoisted(() => ({
  loadSessionStoreMock: vi.fn(),
}));

vi.mock("./bot-runtime-api.js", async () => {
  const actual =
    await vi.importActual<typeof import("./bot-runtime-api.js")>("./bot-runtime-api.js");
  return {
    ...actual,
    loadSessionStore: loadSessionStoreMock,
  };
});

const emptyCfg: ClawdbotConfig = {};

describe("resolveFeishuReasoningPreviewEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables previews only for stream reasoning sessions", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:dm:ou_sender_1": { reasoningLevel: "stream" },
      "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "on" },
    });

    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: emptyCfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(true);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: emptyCfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_2",
      }),
    ).toBe(false);
  });

  it("returns false for missing sessions or load failures", () => {
    loadSessionStoreMock.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: emptyCfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(false);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: emptyCfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
      }),
    ).toBe(false);
  });

  it("uses config reasoningDefault as fallback when session has no level", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:dm:ou_sender_1": {},
    });

    const cfgWithStream: ClawdbotConfig = {
      agents: {
        list: [{ id: "main", reasoningDefault: "stream" }],
      },
    };

    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: cfgWithStream,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(true);
  });

  it("returns config default when no session key is provided", () => {
    const cfgWithStream: ClawdbotConfig = {
      agents: {
        list: [{ id: "main", reasoningDefault: "stream" }],
      },
    };

    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: cfgWithStream,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
      }),
    ).toBe(true);

    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: emptyCfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
      }),
    ).toBe(false);
  });

  it("session-level off overrides config default stream", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:dm:ou_sender_1": { reasoningLevel: "off" },
    });

    const cfgWithStream: ClawdbotConfig = {
      agents: {
        list: [{ id: "main", reasoningDefault: "stream" }],
      },
    };

    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: cfgWithStream,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(false);
  });
});
