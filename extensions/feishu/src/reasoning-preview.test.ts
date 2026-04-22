import { describe, expect, it } from "vitest";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";

describe("resolveFeishuReasoningPreviewEnabled", () => {
  it("returns true for any provided sessionKey", () => {
    expect(
      resolveFeishuReasoningPreviewEnabled({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_1",
      }),
    ).toBe(true);
    expect(
      resolveFeishuReasoningPreviewEnabled({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_sender_2",
      }),
    ).toBe(true);
  });

  it("returns false when sessionKey is missing (equivalent to load failure or missing session)", () => {
    // no sessionKey → false; store is never consulted
    expect(
      resolveFeishuReasoningPreviewEnabled({
        storePath: "/tmp/feishu-sessions.json",
      }),
    ).toBe(false);
  });

  it("returns true for first-turn scenario — sessionKey provided but store is empty (regression)", () => {
    // Previously returned false because no session entry existed in the store yet.
    // Now session key presence alone is sufficient to enable the thinking card preview.
    expect(
      resolveFeishuReasoningPreviewEnabled({
        storePath: "/tmp/feishu-sessions.json",
        sessionKey: "agent:main:feishu:dm:ou_new_user",
      }),
    ).toBe(true);
  });
});
