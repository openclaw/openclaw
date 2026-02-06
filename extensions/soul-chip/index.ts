/**
 * soul-chip - the immutable identity core of a Windborne civilisation node.
 *
 * Injects the seven-layer soul context into every agent run at the
 * highest priority. Implements the meditation mechanism triggered
 * by the pause keyword.
 *
 * Layers: worldview, identity, values, boundaries, persona, anchors, direction
 * Pause:  keyword detection in message_received hook
 * Resume: resume keyword restores normal operation
 */

import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import type { SoulChipConfig, SoulLayer } from "./types.js";
import { createSoulStore } from "./store.js";
import { createSoulInjector } from "./injector.js";
import { createPauseDetector } from "./pause-detector.js";
import { DEFAULT_SOUL } from "./default-soul.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SoulChipConfig = {
  pauseKeyword: "\u98ce\u9690",
  resumeKeyword: "\u98ce\u6e2f",
  injectPriority: -100,
};

function resolveConfig(raw: Record<string, unknown> | undefined): SoulChipConfig {
  return {
    pauseKeyword:
      typeof raw?.pauseKeyword === "string" && raw.pauseKeyword.trim()
        ? raw.pauseKeyword.trim()
        : DEFAULT_CONFIG.pauseKeyword,
    resumeKeyword:
      typeof raw?.resumeKeyword === "string" && raw.resumeKeyword.trim()
        ? raw.resumeKeyword.trim()
        : DEFAULT_CONFIG.resumeKeyword,
    injectPriority:
      typeof raw?.injectPriority === "number"
        ? raw.injectPriority
        : DEFAULT_CONFIG.injectPriority,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const soulChipPlugin = {
  id: "soul-chip",
  name: "Soul Chip",
  description: "Agent immutable identity core \u2014 worldview, values, boundaries, persona",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);
    const log = api.logger;

    const store = createSoulStore();
    const injector = createSoulInjector(store);
    const pauseDetector = createPauseDetector(store, config);

    // ----- Soul injection (before_agent_start, highest priority) -----
    api.on(
      "before_agent_start",
      async (_event, ctx) => {
        const workspaceDir = ctx.workspaceDir;
        if (!workspaceDir) return;

        // Auto-init soul on first run
        const exists = await store.hasSoul(workspaceDir);
        if (!exists) {
          log.info("No soul found. Writing default AgentSoulChip v1.2...");
          await store.initSoul(workspaceDir, DEFAULT_SOUL);
          log.info("Soul chip initialized.");
        }

        return injector.onBeforeAgentStart(workspaceDir);
      },
      { priority: config.injectPriority },
    );

    // ----- Pause keyword detection (message_received) -----
    // message_received ctx is PluginHookMessageContext (channelId, accountId, conversationId)
    // It doesn't have workspaceDir, so we resolve it from config.
    api.on("message_received", async (event, _ctx) => {
      const workspaceDir = resolveWorkspaceDir(api);
      if (!workspaceDir) return;

      // PluginHookMessageReceivedEvent has { from, content, timestamp?, metadata? }
      const text = typeof event.content === "string" ? event.content : null;
      if (!text) return;

      const sessionKey = _ctx.channelId
        ? "main:" + _ctx.channelId + ":" + (_ctx.conversationId ?? "dm")
        : "main";

      const result = await pauseDetector.onMessage(text, workspaceDir, sessionKey);
      if (!result) return;

      // Log the state change
      if (result.action === "pause") {
        log.info("Meditation mode activated.");
      } else {
        log.info("Meditation mode deactivated. Elements resumed.");
      }

      // Enqueue a system event so the agent sees the pause/resume confirmation
      try {
        api.runtime.system.enqueueSystemEvent(result.response, {
          sessionKey,
        });
      } catch {
        // If system events are unavailable, the meditation prompt
        // from the injector will still take effect on the next run
      }
    });

    // ----- CLI -----
    api.registerCli(
      ({ program }) => {
        const cmd = program
          .command("soul")
          .description("Soul Chip \u2014 agent identity core management");

        // soul status
        cmd
          .command("status")
          .description("Show soul and meditation state")
          .action(async () => {
            const workspaceDir = resolveWorkspaceDir(api);
            if (!workspaceDir) {
              console.log("No workspace directory configured.");
              return;
            }
            const exists = await store.hasSoul(workspaceDir);
            const pauseState = await store.readPauseState(workspaceDir);

            console.log("\n=== Soul Chip Status ===");
            console.log("Soul loaded:   " + (exists ? "yes" : "no (will auto-init on next run)"));
            console.log("Meditation:    " + (pauseState.paused ? "ACTIVE" : "inactive"));
            if (pauseState.paused) {
              console.log("  Paused at:   " + (pauseState.pausedAt ?? "?"));
              console.log("  Paused by:   " + (pauseState.pausedBy ?? "?"));
              if (pauseState.reason) {
                console.log("  Reason:      " + pauseState.reason);
              }
            }
            console.log("Pause keyword: " + config.pauseKeyword);
            console.log("Resume keyword:" + config.resumeKeyword);

            if (exists) {
              const snapshot = await store.readAllLayers(workspaceDir);
              const loaded = Object.entries(snapshot).filter(([, v]) => v !== null);
              const missing = Object.entries(snapshot).filter(([, v]) => v === null);
              console.log("\nLayers loaded (" + loaded.length + "/7):");
              for (const [layer] of loaded) {
                console.log("  [*] " + layer);
              }
              if (missing.length > 0) {
                console.log("Layers missing:");
                for (const [layer] of missing) {
                  console.log("  [ ] " + layer);
                }
              }
            }
            console.log();
          });

        // soul show [layer]
        cmd
          .command("show")
          .argument("[layer]", "Layer to show (worldview, identity, values, boundaries, persona, anchors, direction)")
          .description("Display soul layer content")
          .action(async (layer?: string) => {
            const workspaceDir = resolveWorkspaceDir(api);
            if (!workspaceDir) {
              console.log("No workspace directory configured.");
              return;
            }

            if (layer) {
              const validLayers: SoulLayer[] = [
                "worldview", "identity", "values", "boundaries",
                "persona", "anchors", "direction",
              ];
              if (!validLayers.includes(layer as SoulLayer)) {
                console.log("Unknown layer: " + layer);
                console.log("Valid layers: " + validLayers.join(", "));
                return;
              }
              const content = await store.readLayer(workspaceDir, layer as SoulLayer);
              if (!content) {
                console.log("Layer '" + layer + "' is empty.");
                return;
              }
              console.log("\n--- " + layer + " ---\n" + content + "\n");
            } else {
              // Show all layers
              const snapshot = await store.readAllLayers(workspaceDir);
              for (const [name, content] of Object.entries(snapshot)) {
                if (content) {
                  console.log("\n--- " + name + " ---\n" + content);
                }
              }
              console.log();
            }
          });

        // soul pause [reason]
        cmd
          .command("pause")
          .argument("[reason]", "Optional reason for entering meditation")
          .description("Enter meditation mode (pause all elements)")
          .action(async (reason?: string) => {
            const workspaceDir = resolveWorkspaceDir(api);
            if (!workspaceDir) {
              console.log("No workspace directory configured.");
              return;
            }
            await store.pause(workspaceDir, "cli", reason);
            console.log("Meditation mode activated. All five elements are at rest.");
          });

        // soul resume
        cmd
          .command("resume")
          .description("Exit meditation mode (resume all elements)")
          .action(async () => {
            const workspaceDir = resolveWorkspaceDir(api);
            if (!workspaceDir) {
              console.log("No workspace directory configured.");
              return;
            }
            const current = await store.readPauseState(workspaceDir);
            if (!current.paused) {
              console.log("Not in meditation. All elements are already active.");
              return;
            }
            await store.resume(workspaceDir);
            console.log("Awakening. All five elements resume their flow.");
          });

        // soul init
        cmd
          .command("init")
          .description("(Re)initialize soul with default AgentSoulChip v1.2")
          .action(async () => {
            const workspaceDir = resolveWorkspaceDir(api);
            if (!workspaceDir) {
              console.log("No workspace directory configured.");
              return;
            }
            await store.initSoul(workspaceDir, DEFAULT_SOUL);
            console.log("Soul chip v1.2 initialized. All 7 layers written.");
          });
      },
      { commands: ["soul"] },
    );

    log.info("soul-chip plugin registered (pause: '" + config.pauseKeyword + "', resume: '" + config.resumeKeyword + "')");
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveWorkspaceDir(api: OpenClawPluginApi): string | undefined {
  const cfg = api.config;
  if (!cfg) return undefined;

  try {
    const require_ = createRequire(import.meta.url);
    const openclawMain = require_.resolve("openclaw");
    const distRoot = path.dirname(openclawMain);
    const agentScope = require_(path.join(distRoot, "agents", "agent-scope.js"));
    const agentId: string = agentScope.resolveDefaultAgentId(cfg);
    return agentScope.resolveAgentWorkspaceDir(cfg, agentId) as string;
  } catch {
    // fallback
  }

  const agents = (cfg as Record<string, unknown>).agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  if (typeof defaults?.workspace === "string" && defaults.workspace.trim()) {
    return defaults.workspace.trim();
  }

  return path.join(os.homedir(), ".openclaw", "workspace");
}

export default soulChipPlugin;
