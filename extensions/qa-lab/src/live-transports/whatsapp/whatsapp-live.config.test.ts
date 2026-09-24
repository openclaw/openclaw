import fs from "node:fs/promises";
import path from "node:path";
import { readConfigFileSnapshot, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/health";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { buildQaGatewayConfig } from "../../qa-gateway-config.js";
import { buildWhatsAppQaConfig } from "./whatsapp-live.config.js";
import { whatsappQaBroadcastGroupFanoutScenario } from "./whatsapp-live.scenario-implementations.conversation.js";

describe("WhatsApp QA broadcast config", () => {
  it.each(["generated", "explicit", "legacy-default"] as const)(
    "builds valid WhatsApp broadcast config from the %s roster without replacing agents",
    async (roster) => {
      await withTempHome(
        async (home) => {
          const groupJid = "120363000000000000@g.us";
          const base = buildQaGatewayConfig({
            bind: "loopback",
            gatewayPort: 18789,
            gatewayToken: "test-token",
            providerMode: "mock-openai",
            workspaceDir: path.join(home, "workspace"),
          });
          if (roster !== "generated") {
            base.agents = {
              ...base.agents,
              ...(roster === "explicit"
                ? {
                    ownership: "explicit",
                    defaults: { ...base.agents?.defaults, systemAgent: { agentId: "main" } },
                  }
                : {}),
              entries: {
                ...base.agents?.entries,
                main: {
                  ...(roster === "legacy-default" ? { default: true } : {}),
                  identity: { name: "Existing main agent" },
                  model: "mock-openai/custom-main",
                },
              },
            };
          }
          const original = structuredClone(base);
          const cfg = buildWhatsAppQaConfig(base, {
            allowFrom: ["*"],
            authDir: path.join(home, "auth"),
            dmPolicy: "open",
            groupJid,
            ownerAllowFrom: ["+15550000001"],
            overrides: whatsappQaBroadcastGroupFanoutScenario.configOverrides,
            sutAccountId: "sut",
          });

          await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), JSON.stringify(cfg));
          const snapshot = await readConfigFileSnapshot({
            pluginValidation: "core-only",
            observe: false,
          });
          expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
          expect(cfg.agents?.defaults).toMatchObject(original.agents?.defaults ?? {});
          const route = { channel: "whatsapp", accountId: "sut" };
          expect(resolveAgentRoute({ cfg, ...route }).agentId).toBe(
            resolveAgentRoute({ cfg: original, ...route }).agentId,
          );
          for (const agentId of Object.keys(original.agents?.entries ?? {})) {
            expect(resolveAgentWorkspaceDir(cfg, agentId)).toBe(
              resolveAgentWorkspaceDir(original, agentId),
            );
          }
          expect(cfg.agents?.entries).toMatchObject(original.agents?.entries ?? {});
          expect(Object.keys(cfg.agents?.entries ?? {})).toEqual(["qa", "main", "qa-second"]);
          expect(cfg.agents?.entries?.["qa-second"]).toEqual({
            identity: { name: "Second WhatsApp QA" },
          });
          expect(cfg.broadcast?.strategy).toBe("sequential");
          expect(cfg.broadcast?.[groupJid]).toEqual(["main", "qa-second"]);
          expect(cfg.channels?.whatsapp?.accounts?.sut?.groups?.[groupJid]?.requireMention).toBe(
            true,
          );
          expect(base).toEqual(original);
        },
        { env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") } },
      );
    },
  );
});
