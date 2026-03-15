import type { OpenClawConfig, PluginRuntime, ResolvedLineAccount } from "openclaw/plugin-sdk/line";
import { describe, expect, it, vi } from "vitest";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";

describe("linePlugin config.describeAccount", () => {
  it("uses resolved account credentials instead of raw config snapshot", () => {
    const resolveLineAccount = vi.fn(
      ({ accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
        ({
          accountId: accountId ?? "default",
          name: "LINE",
          enabled: true,
          channelAccessToken: "resolved-token",
          channelSecret: "resolved-secret",
          tokenSource: "env",
          config: {},
        }) as ResolvedLineAccount,
    );

    const runtime = {
      channel: {
        line: {
          resolveLineAccount,
          listLineAccountIds: () => ["default"],
          resolveDefaultLineAccountId: () => "default",
        },
      },
    } as unknown as PluginRuntime;
    setLineRuntime(runtime);

    const rawAccount = {
      accountId: "default",
      name: "LINE",
      enabled: true,
      channelAccessToken: "",
      channelSecret: "",
      tokenSource: "env",
      config: {},
    } as ResolvedLineAccount;

    const snapshot = linePlugin.config.describeAccount?.(rawAccount, {} as OpenClawConfig);

    expect(resolveLineAccount).toHaveBeenCalledWith({ cfg: {}, accountId: "default" });
    expect(snapshot).toMatchObject({
      accountId: "default",
      configured: true,
      tokenSource: "env",
    });
  });
});
