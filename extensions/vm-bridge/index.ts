/**
 * VM-Bridge Orchestrator — OpenClaw Extension
 *
 * Full orchestration loop: poll messages → classify → create contracts →
 * dispatch to VMs → handle checkpoints → draft replies → send.
 *
 * Two human checkpoints via Outlook emails to self:
 *   1. Contract review (intent + qa_doc + project) — approve/reject/edit
 *   2. Reply review (draft + screenshot) — approve/revise
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { pluginConfigSchema, type VmBridgeConfig } from "./src/config.js";
import { Db } from "./src/db.js";
import { BridgeClient } from "./src/bridge-client.js";
import { Notifier } from "./src/notifier.js";
import { createContractPollTool } from "./src/tools/contract-poll.js";
import { createContractClaimTool } from "./src/tools/contract-claim.js";
import { createContractReadTool } from "./src/tools/contract-read.js";
import { createContractUpdateTool } from "./src/tools/contract-update.js";
import { createPollerService } from "./src/services/poller.js";
import { createBridgeHealthService } from "./src/services/bridge-health.js";
import { createVmAgentLoop } from "./src/services/vm-agent-loop.js";
import { createCheckpointHandler } from "./src/hooks/checkpoint-handler.js";

const vmBridgePlugin = {
  id: "vm-bridge",
  name: "VM Bridge Orchestrator",
  description:
    "Orchestration loop: poll messages, classify, create contracts, dispatch to VMs, handle human checkpoints via Zoom",
  configSchema: pluginConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = pluginConfigSchema.parse(api.pluginConfig) as VmBridgeConfig;
    const db = new Db(config.database);
    const bridge = new BridgeClient(config.bridge);
    const notifier = new Notifier(bridge, config.checkpoints);

    // --- Tools (for VM agents) ---
    api.registerTool(createContractPollTool(db), { optional: true });
    api.registerTool(createContractClaimTool(db), { optional: true });
    api.registerTool(createContractReadTool(db, bridge), { optional: true });
    api.registerTool(createContractUpdateTool(db), { optional: true });

    // --- Services (background daemons) ---
    api.registerService(createPollerService(db, config, bridge, notifier));
    api.registerService(createBridgeHealthService(bridge, config.bridge.healthCheckMs));

    // VM agent loop — only runs when hostname is configured (i.e. on VMs, not on Mac)
    if (config.agentLoop.hostname) {
      api.registerService(
        createVmAgentLoop({
          hostname: config.agentLoop.hostname,
          pollIntervalMs: config.agentLoop.pollIntervalMs,
          db,
          bridge,
        }),
      );
    }

    // --- Hooks ---
    const checkpointHandler = createCheckpointHandler(db, config, bridge, api.logger);
    api.on("message_received", async (event) => {
      await checkpointHandler({
        content: (event as Record<string, unknown>).content as string | undefined,
        senderEmail: (event as Record<string, unknown>).senderEmail as string | undefined,
      });
    });

    // --- CLI ---
    api.registerCli(
      ({ program }) => {
        const cmd = program.command("vm-bridge").description("VM Bridge orchestration commands");

        cmd
          .command("status")
          .description("Show contract counts by state")
          .action(async () => {
            const counts = await db.getContractCounts();
            console.log("Contract status:");
            for (const [state, count] of Object.entries(counts)) {
              console.log(`  ${state}: ${count}`);
            }
            if (Object.keys(counts).length === 0) {
              console.log("  (no contracts)");
            }
          });

        cmd
          .command("health")
          .description("Check bridge server health")
          .action(async () => {
            const result = await bridge.health();
            if (result.ok) {
              console.log("Bridge: OK");
              const servers = await bridge.servers();
              console.log("MCP servers:", JSON.stringify(servers, null, 2));
            } else {
              console.log(`Bridge: UNREACHABLE — ${result.error}`);
            }
          });

        cmd
          .command("migrate")
          .description("Run database migrations (create tables)")
          .action(async () => {
            await db.migrate();
            console.log("Database migrated successfully.");
          });

        cmd
          .command("contracts")
          .description("List contracts")
          .option("--state <state>", "Filter by state")
          .option("--owner <owner>", "Filter by VM owner")
          .option("--limit <n>", "Max results", "20")
          .action(async (opts: { state?: string; owner?: string; limit?: string }) => {
            // Simple listing via direct query — in production, add proper pagination
            const conditions: string[] = [];
            const values: unknown[] = [];
            let idx = 1;

            if (opts.state) {
              conditions.push(`state = $${idx++}`);
              values.push(opts.state.toUpperCase());
            }
            if (opts.owner) {
              conditions.push(`owner = $${idx++}`);
              values.push(opts.owner);
            }

            const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
            const limit = parseInt(opts.limit ?? "20", 10);

            // Use the db pool for this admin query
            const contracts = await db.queryContracts(where, values, limit);
            for (const c of contracts) {
              console.log(
                `#${c.id} [${c.state}] ${c.intent.slice(0, 60)} (owner: ${c.owner}, project: ${c.project_id ?? "—"})`,
              );
            }
            if (contracts.length === 0) {
              console.log("No contracts found.");
            }
          });
      },
      { commands: ["vm-bridge"] },
    );

    api.logger.info("[vm-bridge] Extension registered");
  },
};

export default vmBridgePlugin;
