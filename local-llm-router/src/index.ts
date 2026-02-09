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
import { CommsAgent } from "./agents/comms.js";
import { BrowserAgent } from "./agents/browser-agent.js";
import { CoderAgent } from "./agents/coder.js";
import { MonitorAgent } from "./agents/monitor.js";
import type { AgentId, ModelsRegistry, RouterConfig } from "./types.js";
import type { RoutingConfig } from "./router/dispatcher.js";
import type { AgentDeps } from "./agents/base-agent.js";
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
// Stub model caller (to be replaced with Pi integration)
// ---------------------------------------------------------------------------

async function callModel(
  provider: string,
  model: string,
  prompt: string,
): Promise<string> {
  // TODO: Replace with Pi's streamSimple / completeSimple
  // For now, stub that calls Ollama directly for local testing
  if (provider === "ollama") {
    try {
      const response = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
        }),
      });
      if (!response.ok) {
        throw new Error(`Ollama ${response.status}: ${response.statusText}`);
      }
      const data = (await response.json()) as { response: string };
      return data.response;
    } catch (err) {
      throw new Error(
        `Ollama call failed (${model}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic ${response.status}: ${body}`);
    }
    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const textBlock = data.content.find((c) => c.type === "text");
    return textBlock?.text ?? "";
  }

  throw new Error(`Unknown provider: ${provider}`);
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

  // Create persistence
  const auditLog = new AuditLog(path.join(PROJECT_ROOT, "logs", "audit"));
  const errorJournal = new ErrorJournal(path.join(PROJECT_ROOT, "errors"));

  // Create agent deps
  const agentDeps: AgentDeps = {
    auditLog,
    errorJournal,
    projectRoot: PROJECT_ROOT,
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
  console.log(`[init] Models: ${Object.keys(modelsRegistry.local).length} local, ${Object.keys(modelsRegistry.cloud).length} cloud`);

  // Start monitor agent background services
  const monitor = agents.monitor as MonitorAgent;
  // These will be implemented later — just log for now
  // await monitor.startEmailMonitor();
  // await monitor.startCronScheduler();

  // Run terminal channel
  await runTerminal(router);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
