import { describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "../api.js";
import { lineStatusAdapter } from "./status.js";

const collect = lineStatusAdapter.collectStatusIssues!;
const issue = { channel: "line", accountId: "default", kind: "config" };
function snapshot(probe: ChannelAccountSnapshot["probe"]): ChannelAccountSnapshot {
  return { accountId: "default", enabled: true, configured: true, tokenSource: "config", probe };
}

describe("LINE status issues", () => {
  it("keeps an opaque webhook route out of snapshots and remediation", async () => {
    const account = await lineStatusAdapter.buildAccountSnapshot!({
      cfg: {},
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        signingSecretSource: "config",
        tokenStatus: "available",
        signingSecretStatus: "available",
        config: { webhookPath: "hooks/line-primary/" },
      },
      probe: { ok: true, webhook: { status: "unset" } },
    });
    const issues = collect([account]);
    expect(JSON.stringify(issues)).not.toContain("hooks/line-primary");
    expect(JSON.stringify(account)).not.toContain("hooks/line-primary");
    expect(issues).toEqual([
      {
        ...issue,
        message:
          "LINE is not delivering webhook events: this channel has no webhook URL registered.",
        fix: "register your gateway's public HTTPS URL for the route in channels.line.webhookPath (default /line/webhook) in the channel's Messaging API tab in the LINE Developers Console, then turn Use webhook on",
      },
    ]);
  });

  it("reports a registered webhook that is switched off", () => {
    expect(collect([snapshot({ ok: true, webhook: { status: "disabled" } })])).toEqual([
      {
        ...issue,
        message:
          "LINE is not delivering webhook events: this channel's webhook URL is registered but switched off.",
        fix: "turn Use webhook on in the channel's Messaging API tab in the LINE Developers Console",
      },
    ]);
  });

  it("leaves active and unanswered webhooks quiet", () => {
    expect(
      collect([
        snapshot({ ok: true, webhook: { status: "active" } }),
        snapshot({ ok: false, error: "timeout" }),
      ]),
    ).toStrictEqual([]);
  });

  it("reports a missing secret when a token source exists", () => {
    expect(collect([{ accountId: "default", configured: false, tokenSource: "env" }])).toEqual([
      { ...issue, message: "LINE channel secret not configured" },
    ]);
  });
});
