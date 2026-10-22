import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readConfigFileSnapshot, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/health";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { buildQaGatewayConfig } from "../../qa-gateway-config.js";
import { buildWhatsAppQaConfig } from "./whatsapp-live.config.js";
import { whatsappConversationScenarios } from "./whatsapp-live.scenario-implementations.conversation.js";

const audio = (model: string) => ({ provider: "openai", model, capabilities: ["audio" as const] });
const gateway = { bind: "loopback", gatewayPort: 18789, gatewayToken: "test-token" } as const;

it("preserves audio preflight when enabling message actions", () => {
  const media = {
    audio: { enabled: false },
    models: [audio("existing-transcriber")],
  } satisfies NonNullable<NonNullable<OpenClawConfig["tools"]>["media"]>;
  const base: OpenClawConfig = { tools: { alsoAllow: ["browser"], media } };
  const cfg = buildWhatsAppQaConfig(base, {
    allowFrom: ["+15550000001"],
    authDir: "/tmp/whatsapp-qa-auth",
    dmPolicy: "allowlist",
    ownerAllowFrom: ["+15550000001"],
    overrides: { audioPreflight: true, actions: true },
    sutAccountId: "sut",
  });

  expect(cfg.tools).toMatchObject({
    alsoAllow: ["browser", "message"],
    media: {
      audio: { enabled: true },
      models: [audio("gpt-4o-transcribe"), audio("existing-transcriber")],
    },
  });
  expect(base.tools?.media?.audio?.enabled).toBe(false);
});

async function checkBroadcast(roster: "generated" | "explicit", home: string) {
  const groupJid = "120363000000000000@g.us";
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
