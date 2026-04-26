import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerOrchestratorCli } from "./src/cli.js";
import { tryReadCredentials } from "./src/credentials.js";
import { dispatchTask } from "./src/dispatch.js";
import { createOrchestratorHttpHandler, type DispatchMode } from "./src/http.js";
import { loadConfig } from "./src/routing.js";
import { createStore } from "./src/store.js";
import type { Task } from "./src/types/schema.js";

const VALID_MODES: ReadonlySet<DispatchMode> = new Set<DispatchMode>([
  "synthetic",
  "shadow",
  "live",
]);

function readMode(pluginConfig?: Record<string, unknown>): DispatchMode {
  const value = (pluginConfig as { mode?: unknown } | undefined)?.mode;
  if (typeof value === "string" && VALID_MODES.has(value as DispatchMode)) {
    return value as DispatchMode;
  }
  return "synthetic";
}

function readEnabled(pluginConfig?: Record<string, unknown>): boolean {
  const value = (pluginConfig as { enabled?: unknown } | undefined)?.enabled;
  return value === undefined || value === true;
}

export default definePluginEntry({
  id: "orchestrator",
  name: "Fleet Orchestrator",
  description:
    "Phase B routing layer — schema, deterministic routing engine, file-backed task store, CLI verbs, and the cross-repo HTTP mutate API.",
  register(api) {
    if (!readEnabled(api.pluginConfig)) {
      api.logger.info?.("orchestrator extension disabled via pluginConfig.enabled");
      return;
    }

    api.registerCli(
      ({ program }) => {
        registerOrchestratorCli(program);
      },
      {
        descriptors: [
          {
            name: "orchestrator",
            description: "Manage the orchestrator routing layer (init credentials, rotate token)",
            hasSubcommands: true,
          },
        ],
      },
    );

    const mode = readMode(api.pluginConfig);

    let store: ReturnType<typeof createStore> | null = null;
    let routingConfigCache: ReturnType<typeof loadConfig> | null = null;
    function getRoutingConfig(): ReturnType<typeof loadConfig> | null {
      if (routingConfigCache !== null) {
        return routingConfigCache;
      }
      try {
        routingConfigCache = loadConfig({ skipAgentValidation: true });
        return routingConfigCache;
      } catch (err) {
        api.logger.error?.(
          `orchestrator: failed to load routing config — HTTP routes will return 503: ${
            (err as Error).message
          }`,
        );
        return null;
      }
    }

    function getStore(): ReturnType<typeof createStore> {
      if (store === null) {
        store = createStore({});
      }
      return store;
    }

    api.registerHttpRoute({
      path: "/orchestrator/",
      match: "prefix",
      auth: "plugin",
      handler: async (req, res) => {
        const credentials = tryReadCredentials({});
        const loaded = getRoutingConfig();
        if (loaded === null) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: {
                code: "ROUTING_NOT_LOADED",
                message:
                  "orchestrator routing config could not be loaded; check ~/.openclaw/extensions/orchestrator/routing.json",
              },
            }),
          );
          return true;
        }
        const handle = createOrchestratorHttpHandler({
          store: getStore(),
          routingConfig: loaded.config,
          credentials,
          mode,
          dispatch: async (task: Task): Promise<Task> => {
            const result = dispatchTask(task, getStore(), {
              config: loaded.config,
              mode,
            });
            return result.task;
          },
        });
        return await handle(req, res);
      },
    });
  },
});
