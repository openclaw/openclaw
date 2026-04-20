/**
 * AJ Router plugin entry.
 *
 * Wires three surfaces:
 *   - `before_model_resolve` hook → rewrites the model+provider for every
 *     agent run based on the prompt classification + sensitivity policy.
 *   - `/router` command with `stats | health | explain` subcommands.
 *   - JSONL routing log at `<logsDir>/routing.jsonl` for post-hoc analysis.
 *
 * The plugin is disabled by default. Enable it via
 * `plugins.entries["aj-router"].enabled = true` in `openclaw.json`, and
 * optionally override the built-in defaults under `...config`.
 */

import { homedir } from "node:os";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { dispatch } from "./commands.js";
import { resolveConfig, type RouterConfig } from "./config.js";
import { toLogEntry, writeEntry, type LogEntry } from "./logger.js";
import { isRejection, resolve } from "./resolver.js";

const PLUGIN_ID = "aj-router";

type HookResult = {
  modelOverride?: string;
  providerOverride?: string;
};

function splitModelRef(ref: string): { provider: string; model: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    return undefined;
  }
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  if (provider.length === 0 || model.length === 0) {
    return undefined;
  }
  return { provider, model };
}

/**
 * Pure hook implementation. Exported for unit tests; the plugin registration
 * wires it to `api.on("before_model_resolve", ...)`.
 */
export function handleBeforeModelResolve(
  config: RouterConfig,
  prompt: string,
  log: (entry: LogEntry) => void,
): HookResult | undefined {
  if (prompt.length === 0) {
    return undefined;
  }

  const result = resolve({ config, prompt });
  const entry = toLogEntry(result, { promptLength: prompt.length });
  log(entry);

  if (isRejection(result)) {
    // No safe override — fall through and let the caller-chosen model run.
    return undefined;
  }

  const parts = splitModelRef(result.modelRef);
  if (!parts) {
    return { modelOverride: result.modelRef };
  }
  return { modelOverride: parts.model, providerOverride: parts.provider };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "AJ Router",
  description:
    "Classifier-driven model selection: picks the cheapest alias that can handle a prompt, gated by sensitivity policy.",
  register(api: OpenClawPluginApi) {
    const config = resolveConfig({
      raw: api.pluginConfig,
      homeDir: homedir(),
    });

    api.on("before_model_resolve", (event) => {
      try {
        const prompt = typeof event.prompt === "string" ? event.prompt : "";
        return handleBeforeModelResolve(config, prompt, (entry) => {
          void writeEntry({ logsDir: config.logsDir, entry }).catch((err) => {
            api.logger.error?.(
              `aj-router: log write failed: ${(err as Error).message ?? String(err)}`,
            );
          });
        });
      } catch (err) {
        api.logger.error?.(`aj-router: hook failed: ${(err as Error).message ?? String(err)}`);
        return undefined;
      }
    });

    api.registerCommand({
      name: "router",
      description: "AJ router status and diagnostics (stats | health | explain).",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = typeof ctx.args === "string" ? ctx.args : "";
        const text = await dispatch({ config, args });
        return { text };
      },
    });
  },
});
