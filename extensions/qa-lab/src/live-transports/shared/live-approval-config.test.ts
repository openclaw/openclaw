import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildSlackQaConfig } from "../slack/slack-live.config.js";
import { buildWhatsAppQaConfig } from "../whatsapp/whatsapp-live.config.js";

const builders = [
  {
    channel: "Slack",
    build: (base: OpenClawConfig, approvals?: { exec?: boolean; plugin?: boolean }) =>
      buildSlackQaConfig(base, {
        channelId: "C123456789",
        driverBotUserId: "U999999999",
        overrides: { approvals },
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      }),
  },
  {
    channel: "WhatsApp",
    build: (base: OpenClawConfig, approvals?: { exec?: boolean; plugin?: boolean }) =>
      buildWhatsAppQaConfig(base, {
        allowFrom: ["+15550000001"],
        authDir: "/tmp/qa-auth",
        dmPolicy: "allowlist",
        ownerAllowFrom: ["+15550000001"],
        overrides: { approvals },
        sutAccountId: "sut",
      }),
  },
];

describe.each(builders)("$channel approval forwarding config", ({ build }) => {
  it.each([
    { exec: false, plugin: false },
    { exec: true, plugin: false },
    { exec: false, plugin: true },
    { exec: true, plugin: true },
  ])("preserves approval settings with exec=$exec and plugin=$plugin", (overrides) => {
    const base: OpenClawConfig = {
      approvals: {
        exec: { enabled: false, mode: "targets", agentFilter: ["qa"] },
        plugin: {
          enabled: false,
          mode: "both",
          sessionFilter: ["qa-session"],
          targets: [{ channel: "slack", to: "C123456789" }],
        },
      },
    };
    const original = structuredClone(base);
    const cfg = build(base, overrides);

    expect(cfg.approvals).toEqual({
      exec: {
        enabled: overrides.exec,
        mode: overrides.exec ? "session" : "targets",
        agentFilter: ["qa"],
      },
      plugin: {
        enabled: overrides.plugin,
        mode: overrides.plugin ? "session" : "both",
        sessionFilter: ["qa-session"],
        targets: [{ channel: "slack", to: "C123456789" }],
      },
    });
    expect(base).toEqual(original);
    if (!overrides.exec) {
      expect(cfg.approvals?.exec).toBe(base.approvals?.exec);
    }
    if (!overrides.plugin) {
      expect(cfg.approvals?.plugin).toBe(base.approvals?.plugin);
    }
  });

  it("leaves absent approvals absent when no forwarding is requested", () => {
    expect(build({})).not.toHaveProperty("approvals");
    expect(build({}, { exec: false, plugin: false })).not.toHaveProperty("approvals");
  });
});
