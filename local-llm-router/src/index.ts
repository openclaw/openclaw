/**
 * Local LLM Router — Entry Point
 *
 * Personal AI PA + coding agent with local LLM routing.
 * Classifies user intent via small local model, routes to specialised agents,
 * executes via scoped tools, persists sessions and memory via MD files.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Router, type RouterDeps } from "./router/index.js";
import { AuditLog } from "./persistence/audit.js";
import { ErrorJournal } from "./errors/journal.js";
import { loadBootstrapFiles, buildBootstrapContext } from "./persistence/workspace.js";
import { loadAllSkills, filterSkillsForAgent, formatSkillsForPrompt } from "./shared/skill-loader.js";
import { TaskQueue } from "./shared/task-queue.js";
import { callModelSimple } from "./shared/pi-bridge.js";
import { CommsAgent } from "./agents/comms.js";
import { BrowserAgent } from "./agents/browser-agent.js";
import { CoderAgent } from "./agents/coder.js";
import { MonitorAgent } from "./agents/monitor.js";
import type { AgentId, ModelsRegistry } from "./types.js";
import type { RoutingConfig } from "./router/dispatcher.js";
import type { AgentDeps } from "./agents/base-agent.js";
import { createTelegramBot, sendNotification } from "./channels/telegram.js";
import { TokenTracker } from "./monitoring/token-tracker.js";
import * as readline from "node:readline";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

async function loadJsonConfig<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Model caller via Pi bridge
// ---------------------------------------------------------------------------

async function callModel(
  provider: string,
  model: string,
  prompt: string,
): Promise<string> {
  return callModelSimple({ provider, model }, prompt);
}

// ---------------------------------------------------------------------------
// Terminal channel (basic CLI for testing)
// ---------------------------------------------------------------------------

async function runTerminal(router: Router): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n=== Local LLM Router ===");
  console.log("Type a message to route it. Type 'quit' to exit.\n");

  const prompt = (): void => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "quit" || trimmed === "exit") {
        rl.close();
        process.exit(0);
      }

      try {
        const { task, result } = await router.handleMessage(trimmed, "terminal");
        console.log(
          `\n[${task.classification.intent}] → ${task.route.agent} (${task.route.model})` +
            ` | confidence: ${task.classification.confidence}`,
        );
        if (result.success) {
          console.log(result.output);
        } else {
          console.error(`Error: ${result.error}`);
        }
        console.log(`(${result.durationMs}ms)\n`);
      } catch (err) {
        console.error("Router error:", err);
      }

      prompt();
    });
  };

  prompt();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[init] Loading config...");

  // Load configs
  const configDir = path.join(PROJECT_ROOT, "config");
  const modelsRegistry = await loadJsonConfig<ModelsRegistry>(
    path.join(configDir, "models.json"),
  );
  const routesRaw = await loadJsonConfig<RoutingConfig>(
    path.join(configDir, "routes.json"),
  );

  // Load bootstrap context (MD files)
  const bootstrapFiles = await loadBootstrapFiles(configDir);
  const bootstrapContext = buildBootstrapContext(bootstrapFiles);
  console.log(
    `[init] Loaded ${bootstrapFiles.filter((f) => !f.missing).length} bootstrap files`,
  );

  // Load skills
  const skillsDir = path.join(PROJECT_ROOT, "skills");
  const allSkills = await loadAllSkills(skillsDir);
  console.log(`[init] Loaded ${allSkills.size} skills`);

  // Init task queue
  const taskQueue = new TaskQueue(
    path.join(PROJECT_ROOT, "data", "tasks.db"),
  );
  await fs.mkdir(path.join(PROJECT_ROOT, "data"), { recursive: true });
  console.log("[init] Task queue ready");

  // Create persistence
  const auditLog = new AuditLog(path.join(PROJECT_ROOT, "logs", "audit"));
  const errorJournal = new ErrorJournal(path.join(PROJECT_ROOT, "errors"));

  // Create token tracker
  const tokenTracker = new TokenTracker(
    path.join(PROJECT_ROOT, "logs", "tokens"),
    {
      dailyBudgetUsd: parseFloat(process.env.DAILY_BUDGET_USD ?? "5"),
      monthlyBudgetUsd: parseFloat(process.env.MONTHLY_BUDGET_USD ?? "50"),
    },
  );
  console.log("[init] Token tracker ready");

  // Create agent deps (shared by all agents)
  const agentDeps: AgentDeps = {
    auditLog,
    errorJournal,
    projectRoot: PROJECT_ROOT,
    modelsRegistry,
    allSkills,
    bootstrapContext,
    tokenTracker,
  };

  // Load agent configs
  const agentsRaw = await loadJsonConfig<{ agents: Record<string, any> }>(
    path.join(configDir, "agents.json"),
  );

  // Create agents
  const agents: Record<AgentId, CommsAgent | BrowserAgent | CoderAgent | MonitorAgent> = {
    comms: new CommsAgent("comms", agentsRaw.agents.comms, agentDeps),
    browser: new BrowserAgent("browser", agentsRaw.agents.browser, agentDeps),
    coder: new CoderAgent("coder", agentsRaw.agents.coder, agentDeps),
    monitor: new MonitorAgent("monitor", agentsRaw.agents.monitor, agentDeps),
  };

  // Log agent skill assignments
  for (const [id, agent] of Object.entries(agents)) {
    const agentConfig = agentsRaw.agents[id];
    const agentSkills = filterSkillsForAgent(
      allSkills,
      agentConfig.tools,
      agentConfig.skills,
    );
    console.log(
      `[init] Agent '${id}': ${agentConfig.tools.length} tools, ${agentSkills.length} skills`,
    );
  }

  // Create router
  const routerDeps: RouterDeps = {
    modelsRegistry,
    routingConfig: routesRaw,
    auditLog,
    errorJournal,
    agents,
    callModel,
  };

  const router = new Router(routerDeps);

  console.log("[init] Router ready");
  console.log(
    `[init] Models: ${Object.keys(modelsRegistry.local).length} local, ${Object.keys(modelsRegistry.cloud).length} cloud`,
  );

  // Show task queue status
  const counts = taskQueue.counts();
  console.log(
    `[init] Tasks: ${counts.done} done, ${counts.failed} failed, ${counts.pending} pending`,
  );

  // Start monitor background services
  const monitor = agents.monitor as MonitorAgent;
  monitor.startDailyAnalysis(errorJournal);
  monitor.startKnowledgeScout();

  // Start email monitoring if IMAP is configured
  if (process.env.IMAP_HOST) {
    await monitor.startEmailMonitoring(
      {
        host: process.env.IMAP_HOST,
        port: parseInt(process.env.IMAP_PORT ?? "993", 10),
        auth: {
          user: process.env.IMAP_USER ?? "",
          pass: process.env.IMAP_PASS ?? "",
        },
        tls: process.env.IMAP_TLS !== "false",
      },
      async (email) => {
        // Route incoming emails through the router
        const summary = `New email from ${email.from}: "${email.subject}"`;
        try {
          await router.handleMessage(summary, "email");
        } catch (err) {
          console.error("[monitor] Failed to route email:", err);
        }
      },
    );
  }

  // Start health checks if configured
  const healthEndpoints = process.env.HEALTH_CHECK_URLS
    ? process.env.HEALTH_CHECK_URLS.split(",").map((url, i) => ({
        name: `endpoint-${i + 1}`,
        url: url.trim(),
      }))
    : [];
  monitor.startHealthChecks(healthEndpoints);

  // Start Telegram bot if configured
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS ?? "")
      .split(",")
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id));

    const bot = createTelegramBot({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      allowedUsers,
      router,
      tokenTracker,
    });

    bot.start({
      onStart: () => console.log("[init] Telegram bot started"),
    });
    console.log(`[init] Telegram: ${allowedUsers.length} allowed users`);

    // Start budget monitor — alerts via Telegram
    const primaryChatId = allowedUsers[0];
    if (primaryChatId) {
      monitor.startBudgetMonitor(tokenTracker, async (msg) => {
        await sendNotification(bot, primaryChatId, msg);
      });
      monitor.startDailyCostSummary(tokenTracker, async (msg) => {
        await sendNotification(bot, primaryChatId, msg);
      });
    }
  }

  // Run terminal channel (blocks until quit)
  await runTerminal(router);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
