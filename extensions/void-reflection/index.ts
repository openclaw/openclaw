/**
 * void-reflection — the "空" (Void) element for OpenClaw agents.
 *
 * Implements self-observation, self-reflection, and self-iteration by:
 *   1. Observing every agent run (agent_end plugin hook)
 *   2. Periodically reflecting on accumulated patterns (interval + threshold)
 *   3. Injecting reflection context into future runs (before_agent_start plugin hook)
 */

import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import type { VoidReflectionConfig } from "./types.js";
import { createVoidStore } from "./store.js";
import { createObserver } from "./observer.js";
import { createInjector } from "./injector.js";
import { createReflector } from "./reflector.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: VoidReflectionConfig = {
  cronIntervalHours: 6,
  thresholdRuns: 10,
  maxObservations: 200,
  reflectionModel: null,
};

function resolveConfig(raw: Record<string, unknown> | undefined): VoidReflectionConfig {
  return {
    cronIntervalHours:
      typeof raw?.cronIntervalHours === "number" && raw.cronIntervalHours > 0
        ? raw.cronIntervalHours
        : DEFAULT_CONFIG.cronIntervalHours,
    thresholdRuns:
      typeof raw?.thresholdRuns === "number" && raw.thresholdRuns > 0
        ? raw.thresholdRuns
        : DEFAULT_CONFIG.thresholdRuns,
    maxObservations:
      typeof raw?.maxObservations === "number" && raw.maxObservations > 0
        ? raw.maxObservations
        : DEFAULT_CONFIG.maxObservations,
    reflectionModel:
      typeof raw?.reflectionModel === "string" ? raw.reflectionModel : DEFAULT_CONFIG.reflectionModel,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const voidReflectionPlugin = {
  id: "void-reflection",
  name: "Void Reflection (空)",
  description: "Agent self-reflection, self-repair, and self-iteration — the fifth element",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const pluginConfig = resolveConfig(api.pluginConfig);
    const log = api.logger;

    // ----- Store -----
    const store = createVoidStore();

    // ----- Observer (agent_end) -----
    const observer = createObserver(store, pluginConfig);

    api.on("agent_end", async (event, ctx) => {
      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) return;
      await observer.onAgentEnd(event, ctx, workspaceDir);
    });

    // ----- Injector (before_agent_start) -----
    const injector = createInjector(store);

    api.on("before_agent_start", async (_event, ctx) => {
      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) return;
      return injector.onBeforeAgentStart(workspaceDir);
    });

    // ----- Reflector -----
    const reflector = createReflector(store, pluginConfig, api);

    // Wire threshold trigger from observer → reflector
    observer.onThresholdReached = async (workspaceDir: string) => {
      log.info("Threshold reached — starting reflection cycle");
      await reflector.reflect(workspaceDir);
      observer.resetCounter();
    };

    // ----- Periodic timer (gateway_start) -----
    let reflectionInterval: ReturnType<typeof setInterval> | null = null;

    api.on("gateway_start", async (_event, _ctx) => {
      const intervalMs = pluginConfig.cronIntervalHours * 60 * 60 * 1000;

      // Resolve workspace from config
      const workspaceDir = resolveWorkspaceDirFromConfig(api);
      if (!workspaceDir) {
        log.warn("No workspace directory — periodic reflection disabled");
        return;
      }

      reflectionInterval = setInterval(async () => {
        log.info("Periodic reflection cycle starting");
        try {
          await reflector.reflect(workspaceDir);
          observer.resetCounter();
        } catch (err) {
          log.warn(
            `Periodic reflection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }, intervalMs);

      log.info(`Registered periodic reflection (every ${pluginConfig.cronIntervalHours}h)`);
    });

    api.on("gateway_stop", async () => {
      if (reflectionInterval) {
        clearInterval(reflectionInterval);
        reflectionInterval = null;
      }
    });

    // ----- CLI -----
    api.registerCli(
      ({ program }) => {
        const cmd = program.command("void").description("Void reflection (空) — self-observation & self-improvement");

        // void status
        cmd
          .command("status")
          .description("Show current reflection state")
          .action(async () => {
            const workspaceDir = resolveWorkspaceDirFromConfig(api);
            if (!workspaceDir) {
              console.log("No workspace directory configured.");
              return;
            }
            const status = await store.getStatus(workspaceDir);
            console.log("\n=== Void Reflection (空) Status ===");
            console.log(`Observations:      ${status.observationCount}`);
            console.log(`Last reflection:   ${status.lastReflectionTime ?? "never"}`);
            console.log(`Reflections total: ${status.reflectionCount}`);
            if (status.currentExcerpt) {
              console.log(`\nLatest reflection excerpt:\n${status.currentExcerpt}`);
            }
            console.log();
          });

        // void reflect
        cmd
          .command("reflect")
          .description("Trigger an immediate reflection cycle")
          .action(async () => {
            const workspaceDir = resolveWorkspaceDirFromConfig(api);
            if (!workspaceDir) {
              console.log("No workspace directory configured.");
              return;
            }
            console.log("[void-reflection] Starting reflection...");
            await reflector.reflect(workspaceDir);
            observer.resetCounter();
            console.log("[void-reflection] Reflection complete.");
          });

        // void history
        cmd
          .command("history")
          .description("List past reflection files")
          .action(async () => {
            const workspaceDir = resolveWorkspaceDirFromConfig(api);
            if (!workspaceDir) {
              console.log("No workspace directory configured.");
              return;
            }
            const files = await store.listReflections(workspaceDir);
            if (files.length === 0) {
              console.log("No reflections yet.");
              return;
            }
            console.log("\n=== Reflection History ===");
            for (const f of files) {
              console.log(`  ${f}`);
            }
            console.log();
          });
      },
      { commands: ["void"] },
    );

    log.info("void-reflection plugin registered");
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveWorkspaceDirFromConfig(api: OpenClawPluginApi): string | undefined {
  const cfg = api.config;
  if (!cfg) return undefined;

  try {
    // Dynamically import the internal agent-scope module for accurate resolution
    const require_ = createRequire(import.meta.url);
    const openclawMain = require_.resolve("openclaw");
    const distRoot = path.dirname(openclawMain);
    const agentScope = require_(path.join(distRoot, "agents", "agent-scope.js"));
    const agentId: string = agentScope.resolveDefaultAgentId(cfg);
    const workspaceDir: string = agentScope.resolveAgentWorkspaceDir(cfg, agentId);
    return workspaceDir;
  } catch {
    // Fallback: manually extract from config shape
  }

  // Try agents.defaults.workspace from config
  const agents = (cfg as Record<string, unknown>).agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  if (typeof defaults?.workspace === "string" && defaults.workspace.trim()) {
    return defaults.workspace.trim();
  }

  // Last resort: default path
  return path.join(os.homedir(), ".openclaw", "workspace");
}

export default voidReflectionPlugin;
