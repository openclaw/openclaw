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
import { buildWhatsAppQaConfig } from "./whatsapp-live.config.js";
import { whatsappConversationScenarios } from "./whatsapp-live.scenario-implementations.conversation.js";

const audio = (model: string) => ({ provider: "openai", model, capabilities: ["audio" as const] });
const gateway = { bind: "loopback", gatewayPort: 18789, gatewayToken: "test-token" } as const;
const account = (cfg: OpenClawConfig) => cfg.channels?.whatsapp?.accounts?.sut;
type ConfigCase = [
  string,
  Parameters<typeof config>[0],
  (cfg: OpenClawConfig) => unknown,
  unknown,
  OpenClawConfig?,
];
it.each<ConfigCase>([
  [
    "command owners",
    {},
    (cfg) => cfg.commands?.ownerAllowFrom,
    ["telegram:existing-owner", "+15550000001"],
    { commands: { ownerAllowFrom: ["telegram:existing-owner"] } },
  ],
  [
    "approval delivery",
    { overrides: { approvals: { exec: true, plugin: true } } },
    (cfg) => [
      cfg.approvals?.exec,
      cfg.approvals?.plugin,
      account(cfg)?.allowFrom,
      Object.hasOwn(account(cfg) ?? {}, "execApprovals"),
    ],
    [
      { enabled: true, mode: "session" },
      { enabled: true, mode: "session" },
      ["+15550000001"],
      false,
    ],
  ],
  [
    "action discovery",
    { overrides: scenario("whatsapp-agent-message-action-react").configOverrides },
    (cfg) => [
      cfg.channels?.whatsapp?.actions?.reactions,
      cfg.channels?.whatsapp?.reactionLevel,
      cfg.tools?.alsoAllow?.includes("message"),
    ],
    [true, "minimal", true],
  ],
  [
    "blocked group sender",
    {
      allowFrom: ["+15550000000"],
      groupJid,
      overrides: { blockGroupSender: true, groupPolicy: "allowlist" },
    },
    (cfg) => [account(cfg)?.groupPolicy, account(cfg)?.groupAllowFrom, account(cfg)?.groups],
    ["allowlist", ["+15550000001"], undefined],
  ],
  [
    "pending history",
    { groupJid, overrides: scenario("whatsapp-group-pending-history-context").configOverrides },
    (cfg) => {
      const limit = cfg.channels?.whatsapp?.historyLimit ?? cfg.messages?.groupChat?.historyLimit;
      return [
        typeof limit,
        Number(limit) > 0,
        account(cfg)?.replyToMode,
        cfg.messages?.inbound?.byChannel?.whatsapp,
        account(cfg)?.groups?.[groupJid]?.requireMention,
      ];
    },
    ["number", true, "all", 0, true],
  ],
  [
    "mention gating",
    { groupJid },
    (cfg) => [
      cfg.messages?.groupChat?.visibleReplies,
      cfg.messages?.groupChat?.mentionPatterns?.includes("\\bopenclawqa\\b"),
    ],
    ["automatic", true],
  ],
])("configures %s", (_name, options, select, expected, base) => {
  expect(select(config(options, base))).toEqual(expected);
});

it.each([false, true])("preserves audio preflight with existing media=%s", (seeded) => {
  const base: OpenClawConfig = seeded
    ? {
        tools: {
          alsoAllow: ["browser"],
          media: { audio: { enabled: false }, models: [audio("existing-transcriber")] },
        },
      }
    : {};
  const original = structuredClone(base);
  const cfg = config(
    { overrides: { audioPreflight: true, ...(seeded ? { actions: true } : {}) } },
    base,
  );
  expect(cfg.plugins?.allow).toContain("whatsapp");
  expect(cfg.tools).toMatchObject({
    ...(seeded ? { alsoAllow: ["browser", "message"] } : {}),
    media: {
      audio: { enabled: true },
      models: [audio("gpt-4o-transcribe"), ...(seeded ? [audio("existing-transcriber")] : [])],
    },
  });
  expect(base).toEqual(original);
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
      expect(
        JSON.stringify(definition.execution.kind === "flow" && definition.execution.flow),
      ).not.toContain('"patchConfig"');
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
  const cfg = buildWhatsAppQaConfig(base, {
    allowFrom: ["*"],
    authDir: path.join(home, "auth"),
    dmPolicy: "open",
    groupJid,
    ownerAllowFrom: ["+15550000001"],
    overrides: whatsappConversationScenarios.whatsappQaBroadcastGroupFanoutScenario.configOverrides,
    sutAccountId: "sut",
  });

  await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), JSON.stringify(cfg));
  const snapshot = await readConfigFileSnapshot({ pluginValidation: "core-only", observe: false });
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
  expect(cfg.agents?.defaults).toMatchObject(original.agents?.defaults ?? {});
  const placement = (value: OpenClawConfig) => [
    resolveAgentRoute({ cfg: value, channel: "whatsapp", accountId: "sut" }).agentId,
    ...Object.keys(original.agents?.entries ?? {}).map((id) => resolveAgentWorkspaceDir(value, id)),
  ];
  expect(placement(cfg)).toEqual(placement(original));
  const entries = cfg.agents?.entries ?? {};
  expect(entries).toMatchObject(original.agents?.entries ?? {});
  expect(Object.keys(entries)).toEqual(["qa", "main", "qa-second"]);
  expect(entries["qa-second"]).toEqual({ identity: { name: "Second WhatsApp QA" } });
  expect(cfg.broadcast).toEqual({ strategy: "sequential", [groupJid]: ["main", "qa-second"] });
  const group = cfg.channels?.whatsapp?.accounts?.sut?.groups?.[groupJid];
  expect(group?.requireMention).toBe(true);
  expect(base).toEqual(original);
}

it.each(["generated", "explicit"] as const)(
  "builds valid WhatsApp broadcast config from the %s roster without replacing agents",
  (roster) =>
    withTempHome((home) => checkBroadcast(roster, home), {
      env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") },
    }),
);
