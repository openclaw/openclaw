import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWhatsAppAccount } from "@openclaw/whatsapp/api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readConfigFileSnapshot, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/health";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { buildQaGatewayConfig } from "../../qa-gateway-config.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import {
  applyQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayConfigPatches,
} from "../../suite-planning.js";
import { groupJid } from "./runtime.test-support.js";
import { config, scenario } from "./scenario.test-support.js";

const audio = (model: string) => ({ provider: "openai", model, capabilities: ["audio" as const] });
const gateway = { bind: "loopback", gatewayPort: 18789, gatewayToken: "test-token" } as const;
const account = (cfg: OpenClawConfig) => cfg.channels?.whatsapp?.accounts?.sut;
it("adds QA capabilities without replacing existing configuration", () => {
  const base: OpenClawConfig = {
    commands: { ownerAllowFrom: ["telegram:existing-owner"] },
    tools: {
      alsoAllow: ["browser"],
      media: { audio: { enabled: false }, models: [audio("existing-transcriber")] },
    },
  };
  const original = structuredClone(base);
  const cfg = config(
    {
      groupJid,
      overrides: {
        ...scenario("whatsapp-group-pending-history-context").configOverrides,
        ...scenario("whatsapp-agent-message-action-react").configOverrides,
        approvals: { exec: true, plugin: true },
        audioPreflight: true,
      },
    },
    base,
  );
  expect(cfg.commands?.ownerAllowFrom).toEqual(["telegram:existing-owner", "+15550000001"]);
  expect([cfg.approvals?.exec, cfg.approvals?.plugin]).toEqual([
    { enabled: true, mode: "session" },
    { enabled: true, mode: "session" },
  ]);
  expect(account(cfg)?.allowFrom).toEqual(["+15550000001"]);
  expect(Object.hasOwn(account(cfg) ?? {}, "execApprovals")).toBe(false);
  expect(cfg.channels?.whatsapp).toMatchObject({
    actions: { reactions: true },
    reactionLevel: "minimal",
  });
  expect(cfg.tools).toMatchObject({
    alsoAllow: ["browser", "message"],
    media: {
      audio: { enabled: true },
      models: [audio("gpt-4o-transcribe"), audio("existing-transcriber")],
    },
  });
  const limit = cfg.channels?.whatsapp?.historyLimit ?? cfg.messages?.groupChat?.historyLimit;
  expect(typeof limit).toBe("number");
  expect(Number(limit)).toBeGreaterThan(0);
  expect(account(cfg)).toMatchObject({
    replyToMode: "all",
    groups: { [groupJid]: { requireMention: true } },
  });
  expect(cfg.messages?.inbound?.byChannel?.whatsapp).toBe(0);
  expect(cfg.messages?.groupChat?.visibleReplies).toBe("automatic");
  expect(cfg.messages?.groupChat?.mentionPatterns).toContain("\\bopenclawqa\\b");
  expect(cfg.plugins?.allow).toContain("whatsapp");
  expect(base).toEqual(original);
});

it("configures a blocked group sender", () => {
  const cfg = config({
    allowFrom: ["+15550000000"],
    groupJid,
    overrides: { blockGroupSender: true, groupPolicy: "allowlist" },
  });
  expect(account(cfg)).toMatchObject({
    groupPolicy: "allowlist",
    groupAllowFrom: ["+15550000001"],
  });
  expect(account(cfg)?.groups).toBeUndefined();
});

it("seeds audio preflight without existing media", () => {
  const cfg = config({ overrides: { audioPreflight: true } });
  expect(cfg.tools).toMatchObject({
    media: {
      audio: { enabled: true },
      models: [audio("gpt-4o-transcribe")],
    },
  });
});

it("patches effective policy for default and named accounts", () => {
  const policies = [
    ["access-control-dm-disabled", "dmPolicy", "disabled", "allowlist"],
    ["access-control-dm-open", "dmPolicy", "open", "allowlist"],
    ["access-control-group-disabled", "groupPolicy", "disabled", "open"],
    ["access-control-group-open", "groupPolicy", "open", "disabled"],
    ["pairing-block", "dmPolicy", "pairing", "allowlist"],
  ] as const;
  for (const accountId of ["default", "work"]) {
    for (const [name, key, value, stale] of policies) {
      const definition = readQaScenarioById("whatsapp-" + name);
      const base = config(
        { sutAccountId: accountId },
        { channels: { whatsapp: { accounts: { [accountId]: { [key]: stale } } } } },
      );
      const cfg = applyQaSuiteGatewayConfigPatches(
        base,
        collectQaSuiteGatewayConfigPatches([definition], accountId),
      ) as OpenClawConfig;
      const effective = resolveWhatsAppAccount({ cfg, accountId });
      expect(effective[key], definition.id + ":" + accountId).toBe(value);
      if (value === "pairing") {
        expect(effective.allowFrom).toEqual(["+15550000000"]);
      }
    }
  }
});

async function checkBroadcast(roster: "generated" | "explicit", home: string) {
  const workspaceDir = path.join(home, "workspace");
  const base = buildQaGatewayConfig({ ...gateway, workspaceDir });
  if (roster !== "generated") {
    const agents = base.agents;
    assert(agents?.defaults && agents.entries, "QA gateway must seed its agent roster");
    agents.ownership = "explicit";
    agents.defaults.systemAgent = { agentId: "main" };
    agents.entries.main = { identity: { name: "Existing" }, model: "mock-openai/custom" };
  }
  const original = structuredClone(base);
  const overrides = scenario("whatsapp-broadcast-group-fanout").configOverrides;
  const cfg = config({ groupJid, overrides }, base);

  await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), JSON.stringify(cfg));
  const snapshot = await readConfigFileSnapshot({ pluginValidation: "core-only", observe: false });
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
  expect(cfg.agents?.defaults).toMatchObject(original.agents?.defaults ?? {});
  const placement = (value: OpenClawConfig) => [
    resolveAgentRoute({ cfg: value, channel: "whatsapp", accountId: "sut" }).agentId,
    ...Object.keys(original.agents?.entries ?? {}).map((id) => resolveAgentWorkspaceDir(value, id)),
  ];
  expect(placement(cfg)).toEqual(placement(original));
  expect(cfg.agents?.entries).toMatchObject(original.agents?.entries ?? {});
  expect(cfg.agents?.entries).toHaveProperty("qa-second");
  expect(cfg.broadcast).toEqual({ strategy: "sequential", [groupJid]: ["main", "qa-second"] });
  expect(base).toEqual(original);
}

it.each(["generated", "explicit"] as const)(
  "builds valid WhatsApp broadcast config from the %s roster without replacing agents",
  (roster) =>
    withTempHome((home) => checkBroadcast(roster, home), {
      env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") },
    }),
);
