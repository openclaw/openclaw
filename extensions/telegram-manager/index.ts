import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { createHetznerClient } from "./src/hetzner-client.js";
import { createManagerBot } from "./src/manager-bot.js";
import { startProvisioning, retryFailed } from "./src/provisioning-orchestrator.js";
import type { OrchestratorDeps } from "./src/provisioning-orchestrator.js";
import { ProvisioningStore } from "./src/provisioning-store.js";

function readEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export default definePluginEntry({
  id: "telegram-manager",
  name: "Telegram Manager",
  description: "Manager Bot provisioning per-user OpenClaw instances (OP-167)",
  register(api) {
    api.registerTool({
      name: "provisioning_start",
      description:
        "Start provisioning a personal OpenClaw instance (managed bot + Hetzner + install)",
      parameters: Type.Object({
        telegramUserId: Type.String(),
        botName: Type.String(),
        botUsername: Type.String(),
      }),
      outputSchema: Type.Object(
        { state: Type.String(), installationId: Type.String() },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const runtime = api.runtime;
        const store = new ProvisioningStore(
          runtime.state.openKeyedStore({
            namespace: "provisioning",
            maxEntries: 10_000,
            overflowPolicy: "reject-new",
          }),
        );
        const deps = buildDeps(runtime, store);
        const record = await startProvisioning(
          deps,
          params as { telegramUserId: string; botName: string; botUsername: string },
        );
        return {
          content: [
            { type: "text", text: `Provisioning ${record.installationId} → ${record.state}` },
          ],
          details: { state: record.state, installationId: record.installationId },
        };
      },
    });
    api.registerTool({
      name: "provisioning_status",
      description: "Check provisioning status for a Telegram user",
      parameters: Type.Object({ telegramUserId: Type.String() }),
      outputSchema: Type.Object({ state: Type.String() }, { additionalProperties: true }),
      async execute(_id, params) {
        const runtime = api.runtime;
        const store = new ProvisioningStore(
          runtime.state.openKeyedStore({
            namespace: "provisioning",
            maxEntries: 10_000,
            overflowPolicy: "reject-new",
          }),
        );
        const record = await store.load(params.telegramUserId);
        const state = record?.state ?? "NONE";
        return { content: [{ type: "text", text: `State: ${state}` }], details: { state } };
      },
    });
    api.registerTool({
      name: "provisioning_cancel",
      description: "Reset a failed provisioning run to REQUESTED",
      parameters: Type.Object({ telegramUserId: Type.String() }),
      outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
      async execute(_id, params) {
        const runtime = api.runtime;
        const store = new ProvisioningStore(
          runtime.state.openKeyedStore({
            namespace: "provisioning",
            maxEntries: 10_000,
            overflowPolicy: "reject-new",
          }),
        );
        await retryFailed({ store }, params.telegramUserId);
        return { content: [{ type: "text", text: "Reset to REQUESTED" }], details: { ok: true } };
      },
    });

    function buildDeps(runtime: typeof api.runtime, store: ProvisioningStore): OrchestratorDeps {
      const hcloudToken = readEnv("HCLOUD_TOKEN") ?? "";
      return {
        store,
        botCreator: {
          // Production MTProto wiring (gramjs user session) plugs in here.
          // Without TELEGRAM_API_ID/HASH + session the creator throws a clear error.
          async checkUsername() {
            throw new Error(
              "MTProto user session not configured (TELEGRAM_API_ID/TELEGRAM_API_HASH required)",
            );
          },
          async createBot() {
            throw new Error(
              "MTProto user session not configured (TELEGRAM_API_ID/TELEGRAM_API_HASH required)",
            );
          },
        },
        tokenExporter: {
          async exportBotToken() {
            throw new Error("Manager-bot MTProto session not configured");
          },
        },
        hetzner: hcloudToken
          ? createHetznerClient({ token: hcloudToken })
          : {
              async createServer() {
                throw new Error("HCLOUD_TOKEN not configured");
              },
              async getServer() {
                throw new Error("HCLOUD_TOKEN not configured");
              },
            },
        healthProbe: async (host) => {
          const res = await fetch(`http://${host}:18789/health`, {
            signal: AbortSignal.timeout(5_000),
          });
          return res.status;
        },
        config: {
          serverType: readEnv("OPENCLAW_PROVISION_SERVER_TYPE") ?? "cx23",
          location: readEnv("OPENCLAW_PROVISION_LOCATION") ?? "nbg1",
          image: readEnv("OPENCLAW_PROVISION_IMAGE") ?? "debian-12",
          sshKeyNames:
            readEnv("OPENCLAW_PROVISION_SSH_KEYS")
              ?.split(",")
              .map((s) => s.trim())
              .filter(Boolean) ?? [],
          openclawImage: readEnv("OPENCLAW_IMAGE") ?? "ghcr.io/openclaw/openclaw:latest",
        },
        notify: () => undefined,
      };
    }

    // Manager Bot lifecycle is intentionally explicit (not onStartup): the
    // operator starts it with a manager token once BotFather grants
    // bot_can_manage_bots. Expose starter via service handle.
    void createManagerBot;
  },
});
