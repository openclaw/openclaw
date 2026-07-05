// Feishu tests cover reasoning preview plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "./bot-runtime-api.js";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";

<<<<<<< HEAD
const { getSessionEntryMock } = vi.hoisted(() => ({
  getSessionEntryMock: vi.fn(),
=======
const { loadSessionStoreMock } = vi.hoisted(() => ({
  loadSessionStoreMock: vi.fn(),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}));

vi.mock("./bot-runtime-api.js", async () => {
  const actual =
    await vi.importActual<typeof import("./bot-runtime-api.js")>("./bot-runtime-api.js");
  return {
    ...actual,
<<<<<<< HEAD
    getSessionEntry: getSessionEntryMock,
=======
    loadSessionStore: loadSessionStoreMock,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  };
});

afterAll(() => {
  vi.doUnmock("./bot-runtime-api.js");
  vi.resetModules();
});

describe("resolveFeishuReasoningPreviewEnabled", () => {
  const emptyCfg: ClawdbotConfig = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables previews only for stream reasoning sessions", () => {
<<<<<<< HEAD
    getSessionEntryMock.mockImplementation(({ sessionKey }) => {
      const entries = {
        "agent:main:feishu:dm:ou_sender_1": { reasoningLevel: "stream" },
        "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "on" },
      };
      return entries[sessionKey as keyof typeof entries];
=======
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:dm:ou_sender_1": { reasoningLevel: "stream" },
      "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "on" },
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
    expect(getSessionEntryMock).toHaveBeenCalledWith({
      storePath: "/tmp/feishu-sessions.json",
      sessionKey: "agent:main:feishu:dm:ou_sender_1",
      readConsistency: "latest",
    });
  });

  it("returns false for missing sessions or load failures", () => {
    getSessionEntryMock.mockImplementationOnce(() => {
=======
  });

  it("returns false for missing sessions or load failures", () => {
    loadSessionStoreMock.mockImplementationOnce(() => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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

  it("falls back to configured stream defaults", () => {
<<<<<<< HEAD
    getSessionEntryMock.mockImplementation(({ sessionKey }) => {
      const entries = {
        "agent:main:feishu:dm:ou_sender_1": {},
        "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "off" },
      };
      return entries[sessionKey as keyof typeof entries];
=======
    loadSessionStoreMock.mockReturnValue({
      "agent:main:feishu:dm:ou_sender_1": {},
      "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "off" },
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    });

    const cfg: ClawdbotConfig = {
      agents: {
        defaults: { reasoningDefault: "stream" },
        list: [{ id: "Ops", reasoningDefault: "off" }],
      },
    };

    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(true);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg,
        agentId: "ops",
        storePath: "/tmp/feishu-sessions.json",
      }),
    ).toBe(false);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg,
        agentId: "main",
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_2",
      }),
    ).toBe(false);
  });
});
