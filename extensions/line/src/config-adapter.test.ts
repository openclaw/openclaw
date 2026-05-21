import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./channel-api.js";
import { lineConfigAdapter } from "./config-adapter.js";

function envRef(id: string) {
  return { source: "env" as const, provider: "default" as const, id };
}

describe("lineConfigAdapter", () => {
  it("resolves top-level allowFrom without resolving SecretRef credentials", () => {
    const cfg = {
      channels: {
        line: {
          channelAccessToken: envRef("LINE_CHANNEL_ACCESS_TOKEN"),
          channelSecret: envRef("LINE_CHANNEL_SECRET"),
          allowFrom: ["line:user:U123"],
        },
      },
    } satisfies OpenClawConfig;

    expect(lineConfigAdapter.resolveAllowFrom?.({ cfg })).toEqual(["line:user:U123"]);
    expect(() => lineConfigAdapter.resolveAccount(cfg)).toThrow(/unresolved SecretRef/);
  });

  it("resolves account allowFrom without resolving SecretRef credentials", () => {
    const cfg = {
      channels: {
        line: {
          accounts: {
            work: {
              channelAccessToken: envRef("LINE_WORK_CHANNEL_ACCESS_TOKEN"),
              channelSecret: envRef("LINE_WORK_CHANNEL_SECRET"),
              allowFrom: ["line:user:U456"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(lineConfigAdapter.resolveAllowFrom?.({ cfg, accountId: "work" })).toEqual([
      "line:user:U456",
    ]);
    expect(() => lineConfigAdapter.resolveAccount(cfg, "work")).toThrow(/unresolved SecretRef/);
  });
});
