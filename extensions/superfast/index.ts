import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Superfast plugin entrypoint: a shadow-mode System One decision gate.
//
// On each user turn the gate asks a small local decision server for a typed,
// calibrated route recommendation. In this first contribution it runs in SHADOW
// MODE ONLY: it records what it would have chosen but does NOT change routing.
// It is OFF by default and FAILS OPEN — any error, timeout, or missing backend
// falls back to the normal path and never breaks a turn.
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  classifyTurn,
  probeBackend,
  resolveGateSettings,
  type DecisionGateSettings,
  type SuperfastSettingsInput,
} from "./decision-gate.js";

const PLUGIN_ID = "superfast";

/** Resolve the current gate settings from live plugin config, failing safe. */
function readSettings(api: OpenClawPluginApi): DecisionGateSettings {
  let live: Record<string, unknown> | undefined;
  try {
    live = resolveLivePluginConfigObject(
      api.runtime.config?.current
        ? () => api.runtime.config.current() as OpenClawConfig
        : undefined,
      PLUGIN_ID,
      api.pluginConfig as Record<string, unknown>,
    );
  } catch {
    live = api.pluginConfig as Record<string, unknown>;
  }
  return resolveGateSettings(live as SuperfastSettingsInput);
}

/** Return a config draft with the superfast gate enabled flag set. */
function withSuperfastEnabled(cfg: OpenClawConfig, enabled: boolean): OpenClawConfig {
  const entries = { ...cfg.plugins?.entries };
  const existingEntry = (entries[PLUGIN_ID] as Record<string, unknown> | undefined) ?? {};
  const existingConfig = (existingEntry.config as Record<string, unknown> | undefined) ?? {};
  entries[PLUGIN_ID] = {
    ...existingEntry,
    enabled: true,
    config: { ...existingConfig, enabled },
  };
  return { ...cfg, plugins: { ...cfg.plugins, entries } };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Superfast",
  description:
    "Shadow-mode System One decision gate that records a fast-path recommendation per turn without changing routing.",
  register(api: OpenClawPluginApi) {
    // Shadow pass: fire-and-forget. Never awaited, never changes routing, and
    // every failure is swallowed so a turn can never break because of the gate.
    api.on("agent_turn_prepare", (event) => {
      const settings = readSettings(api);
      if (!settings.enabled) {
        return undefined;
      }
      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      if (!prompt) {
        return undefined;
      }
      void classifyTurn(prompt, settings)
        .then((decision) => {
          api.logger.debug?.(
            `superfast: shadow route=${decision?.route ?? "unavailable"}` +
              (decision ? ` latencyMs=${decision.latencyMs}` : ""),
          );
        })
        .catch(() => {
          // Fail open: the gate never affects the turn.
        });
      return undefined;
    });

    api.registerCommand({
      name: "superfast",
      description: "Show or toggle the Superfast shadow decision gate.",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        const sub = (ctx.args ?? "").trim().toLowerCase();

        if (sub === "on" || sub === "off") {
          if (ctx.senderIsOwner !== true) {
            return { text: "⚠️ /superfast on|off requires the owner." };
          }
          const enabled = sub === "on";
          await api.runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            writeOptions: { assertCurrent: ctx.assertOwnerCurrent },
            mutate: (draft) => {
              Object.assign(draft, withSuperfastEnabled(draft, enabled));
            },
          });
          return {
            text: enabled
              ? "Superfast enabled (shadow mode). The gate classifies each turn and logs the recommendation; routing is unchanged and it fails open if the backend is unavailable."
              : "Superfast disabled. The agent runs normally.",
          };
        }

        if (sub && sub !== "status") {
          return { text: "Usage: /superfast <on|off|status>" };
        }

        const settings = readSettings(api);
        if (!settings.enabled) {
          return {
            text:
              "Superfast is OFF. Run /superfast on to enable shadow classification " +
              "(install and start the decision backend first).",
          };
        }
        const healthy = await probeBackend(settings);
        return {
          text: healthy
            ? `Superfast is ON (shadow). Backend reachable at ${settings.endpoint} (model ${settings.model}).`
            : `Superfast is ON but the backend at ${settings.endpoint} is not reachable. The gate fails open (normal behaviour).`,
        };
      },
    });
  },
});
