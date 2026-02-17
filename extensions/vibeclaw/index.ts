import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { createVibeclawTools } from "./src/tools.js";
import {
  initWorkspace,
  resolveWorkspace,
  readConfig,
  getMetrics,
  listCampaigns,
} from "./src/workspace.js";

export default function register(api: OpenClawPluginApi) {
  const config = api.pluginConfig ?? {};
  const workspace = (config.workspace as string) ?? process.env.VIBECLAW_WORKSPACE ?? "";

  // Register all Vibeclaw agent tools
  api.registerTool((ctx) => createVibeclawTools(api, workspace, ctx), {
    names: [
      "vibeclaw_campaign",
      "vibeclaw_status",
      "vibeclaw_learn",
      "vibeclaw_log",
      "vibeclaw_draft",
      "vibeclaw_config",
    ],
  });

  // ── CLI Commands ───────────────────────────────────────────────────────

  api.registerCli(
    ({ program }) => {
      const cmd = program
        .command("vibeclaw")
        .description("Vibeclaw autonomous marketing agent suite");

      // Init: Create workspace with all directories and files
      cmd
        .command("init")
        .description("Initialize Vibeclaw workspace with directories, config, and knowledge files")
        .argument("[path]", "Workspace path", "~/vibeclaw-workspace")
        .action(async (wsPath: string) => {
          const resolved = resolveWorkspace(wsPath);
          api.logger.info(`Initializing Vibeclaw workspace at: ${resolved}`);

          const result = await initWorkspace(wsPath);

          if (result.errors.length > 0) {
            api.logger.error(`Errors: ${result.errors.join(", ")}`);
          }

          api.logger.info(`Created: ${result.created.length} items`);
          for (const item of result.created) {
            api.logger.info(`  + ${item}`);
          }

          if (result.existed.length > 0) {
            api.logger.info(`Already existed: ${result.existed.length} items`);
          }

          api.logger.info("");
          api.logger.info("Next steps:");
          api.logger.info(`  1. Set env: export VIBECLAW_WORKSPACE="${resolved}"`);
          api.logger.info(`  2. Edit config: ${resolved}/config.json`);
          api.logger.info(`  3. Run: openclaw vibeclaw status`);
          api.logger.info(
            `  4. Start a campaign: openclaw agent -m "Plan a product launch campaign"`,
          );
        });

      // Status: Show workspace health and agent metrics
      cmd
        .command("status")
        .description("Show workspace status, agent metrics, and active campaigns")
        .action(async () => {
          const ws = resolveWorkspace(workspace);

          if (!ws) {
            api.logger.error(
              "VIBECLAW_WORKSPACE not set. Run 'openclaw vibeclaw init <path>' first.",
            );
            return;
          }

          api.logger.info(`Workspace: ${ws}`);

          const cfg = await readConfig(workspace);
          if (cfg) {
            const product = cfg.product as Record<string, unknown> | undefined;
            api.logger.info(`Product: ${product?.name || "(not configured)"}`);
            api.logger.info(`URL: ${product?.url || "(not set)"}`);
          } else {
            api.logger.warn("No config.json found. Run 'openclaw vibeclaw init' first.");
          }

          const campaigns = await listCampaigns(workspace);
          const active = campaigns.filter((c) => c.status === "active");
          api.logger.info(`\nCampaigns: ${campaigns.length} total, ${active.length} active`);
          for (const c of campaigns) {
            api.logger.info(`  [${c.status}] ${c.id} — agents: ${c.agents.join(", ")}`);
          }

          const metrics = await getMetrics(workspace);
          const agentNames = Object.keys(metrics);
          if (agentNames.length > 0) {
            api.logger.info("\nAgent Log Metrics:");
            for (const [agent, m] of Object.entries(metrics)) {
              api.logger.info(`  ${agent}: ${m.count} entries (last: ${m.lastEntry ?? "n/a"})`);
            }
          } else {
            api.logger.info("\nNo agent logs yet. Launch a campaign to start.");
          }

          api.logger.info("\nAvailable Skills:");
          const skills = [
            "vibeclaw-orchestrator",
            "intent-sniper",
            "content-syndication",
            "directory-submitter",
            "social-content-factory",
            "x-reply-agent",
            "job-sniper",
            "seo-gap-exploiter",
            "community-engagement",
            "skill-learner",
            "youtube-automation",
          ];
          api.logger.info(`  ${skills.join(", ")}`);
        });

      // Report: Show detailed metrics
      cmd
        .command("report")
        .description("Generate detailed metrics report from agent logs")
        .argument("[campaign]", "Campaign ID (optional, shows all if omitted)")
        .action(async (campaignId?: string) => {
          const ws = resolveWorkspace(workspace);
          if (!ws) {
            api.logger.error("VIBECLAW_WORKSPACE not set.");
            return;
          }

          const metrics = await getMetrics(workspace);
          let totalActions = 0;

          api.logger.info("=== Vibeclaw Metrics Report ===\n");

          for (const [agent, m] of Object.entries(metrics)) {
            totalActions += m.count;
            api.logger.info(`${agent}:`);
            api.logger.info(`  Total actions: ${m.count}`);
            api.logger.info(`  Last activity: ${m.lastEntry ?? "n/a"}`);
          }

          api.logger.info(`\nTotal actions across all agents: ${totalActions}`);

          if (campaignId) {
            api.logger.info(`\nCampaign: ${campaignId}`);
            // Campaign-specific reporting would go here
          }
        });
    },
    { commands: ["vibeclaw"] },
  );

  // ── Hooks ──────────────────────────────────────────────────────────────

  // Inject product context into every agent session when Vibeclaw is configured
  api.on("before_agent_start", async () => {
    if (!workspace) return undefined;

    const cfg = await readConfig(workspace);
    if (!cfg) return undefined;

    const product = cfg.product as Record<string, unknown> | undefined;
    if (!product?.name || !product?.url) return undefined;

    const ws = resolveWorkspace(workspace);

    return {
      prependContext: [
        "<vibeclaw-context>",
        `Product: ${product.name}`,
        `URL: ${product.url}`,
        product.description ? `Description: ${product.description}` : "",
        product.category ? `Category: ${product.category}` : "",
        product.competitors ? `Competitors: ${(product.competitors as string[]).join(", ")}` : "",
        `Workspace: ${ws}`,
        "Vibeclaw tools available: vibeclaw_campaign, vibeclaw_status, vibeclaw_learn, vibeclaw_log, vibeclaw_draft, vibeclaw_config",
        "</vibeclaw-context>",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  });

  api.logger.info(
    `Vibeclaw marketing suite registered${workspace ? ` (workspace: ${resolveWorkspace(workspace)})` : ""}`,
  );
}
