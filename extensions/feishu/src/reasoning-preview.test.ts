// Feishu tests cover reasoning preview plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";

const { getSessionEntryAsyncMock } = vi.hoisted(() => ({
  getSessionEntryAsyncMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    getSessionEntryAsync: getSessionEntryAsyncMock,
  };
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/session-store-runtime");
  vi.resetModules();
});

describe("resolveFeishuReasoningPreviewEnabled", () => {
  function resolvePreview(
    sessionKey?: string,
    overrides: Partial<Parameters<typeof resolveFeishuReasoningPreviewEnabled>[0]> = {},
  ) {
    return resolveFeishuReasoningPreviewEnabled({
      cfg: {},
      agentId: "main",
      storePath: "/tmp/feishu-sessions.json",
      sessionKey,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables previews only for stream reasoning sessions", async () => {
    getSessionEntryAsyncMock.mockImplementation(async ({ sessionKey }) => {
      const entries = {
        "agent:main:feishu:dm:ou_sender_1": { reasoningLevel: "stream" },
        "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "on" },
      };
      return entries[sessionKey as keyof typeof entries];
    });

    expect(await resolvePreview("agent:main:feishu:dm:ou_sender_1")).toBe(true);
    expect(await resolvePreview("agent:main:feishu:dm:ou_sender_2")).toBe(false);
    expect(getSessionEntryAsyncMock).toHaveBeenCalledWith({
      storePath: "/tmp/feishu-sessions.json",
      sessionKey: "agent:main:feishu:dm:ou_sender_1",
      readConsistency: "latest",
    });
  });

  it("returns false for missing sessions or load failures", async () => {
    getSessionEntryAsyncMock.mockImplementationOnce(async () => {
      throw new Error("disk unavailable");
    });

    expect(await resolvePreview("agent:main:feishu:dm:ou_sender_1")).toBe(false);
    expect(await resolvePreview()).toBe(false);
  });

  it("falls back to configured stream defaults", async () => {
    getSessionEntryAsyncMock.mockImplementation(async ({ sessionKey }) => {
      const entries = {
        "agent:main:feishu:dm:ou_sender_1": {},
        "agent:main:feishu:dm:ou_sender_2": { reasoningLevel: "off" },
      };
      return entries[sessionKey as keyof typeof entries];
    });

    const cfg: ClawdbotConfig = {
      agents: {
        defaults: { reasoningDefault: "stream" },
        entries: { Ops: { reasoningDefault: "off" } },
      },
    };

    expect(await resolvePreview("agent:main:feishu:dm:ou_sender_1", { cfg })).toBe(true);
    expect(await resolvePreview(undefined, { cfg, agentId: "ops" })).toBe(false);
    expect(await resolvePreview("agent:main:feishu:dm:ou_sender_2", { cfg })).toBe(false);
  });
});
