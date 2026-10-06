import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it } from "vitest";
import { collectA2aStatusIssues } from "./status-issues.js";

/** Extras such as the withheld-peer lists ride on the snapshot but are not in its declared type. */
function snapshot(fields: Record<string, unknown>): ChannelAccountSnapshot {
  return { accountId: "default", enabled: true, configured: true, ...fields };
}

describe("collectA2aStatusIssues", () => {
  it("reports nothing for a healthy account", () => {
    expect(collectA2aStatusIssues([snapshot({})])).toEqual([]);
  });

  it("names peers whose inbound token reference did not resolve, with a fix", () => {
    const issues = collectA2aStatusIssues([snapshot({ unresolvedPeers: ["lost", "late"] })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ channel: "a2a", accountId: "default", kind: "config" });
    expect(issues[0]?.message).toContain("lost, late");
    expect(issues[0]?.message).toContain("401");
    expect(issues[0]?.fix).toContain("channels.a2a.peers.<name>.token");
  });

  it("names peers whose outbound token reference did not resolve, separately", () => {
    const issues = collectA2aStatusIssues([snapshot({ unresolvedOutboundPeers: ["hermes"] })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("hermes");
    expect(issues[0]?.message).toContain("refused");
    expect(issues[0]?.fix).toContain("outboundToken");
  });

  it("still reports when every peer is withheld and the account reads as unconfigured", () => {
    const issues = collectA2aStatusIssues([
      snapshot({ configured: false, unresolvedPeers: ["only"] }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("only");
  });

  it("skips disabled accounts and malformed rows", () => {
    expect(
      collectA2aStatusIssues([snapshot({ enabled: false, unresolvedPeers: ["lost"] })]),
    ).toEqual([]);
    expect(collectA2aStatusIssues([null as never, "x" as never])).toEqual([]);
  });

  it("ignores non-string peer entries", () => {
    expect(collectA2aStatusIssues([snapshot({ unresolvedPeers: [1, null, ""] })])).toEqual([]);
  });
});
