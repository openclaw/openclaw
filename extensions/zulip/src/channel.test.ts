import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { zulipPlugin } from "./channel.js";
import { resolveZulipAccount } from "./zulip/accounts.js";
import { normalizeEmojiName } from "./zulip/normalize.js";
import { parseZulipTarget } from "./zulip/targets.js";

describe("zulipPlugin", () => {
  it("normalizes emoji names", () => {
    expect(normalizeEmojiName(":eyes:")).toBe("eyes");
    expect(normalizeEmojiName("check")).toBe("check");
  });

  it("parses stream targets with optional topics", () => {
    expect(parseZulipTarget("stream:marcel-ai")).toEqual({ kind: "stream", stream: "marcel-ai" });
    expect(parseZulipTarget("zulip:stream:marcel-ai#deploy")).toEqual({
      kind: "stream",
      stream: "marcel-ai",
      topic: "deploy",
    });
  });

  it("applies defaultTopic when target omits topic", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          defaultTopic: "general chat",
        },
      },
    };
    const account = resolveZulipAccount({ cfg, accountId: "default" });
    const res = zulipPlugin.outbound?.resolveTarget?.({
      cfg,
      to: "stream:marcel-ai",
      accountId: account.accountId,
      mode: "explicit",
    });
    expect(res?.ok).toBe(true);
    if (res && res.ok) {
      expect(res.to).toBe("stream:marcel-ai#general chat");
    }
  });
});
