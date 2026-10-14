import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseTeamReportsConfig, resolveTeamReportsConfig } from "./src/config.js";
import { registerTeamReportsGatewayMethods } from "./src/gateway-methods.js";
import { createTeamReportsHttpHandler } from "./src/http.js";
import { TeamReportsRunner } from "./src/run-worker.js";
import { TeamReportsScheduler } from "./src/scheduler.js";
import { createTeamReportsStore, type TeamReportsStore } from "./src/store.js";
import { listWorkSessions } from "./src/work-sessions.js";

export default definePluginEntry({
  id: "team-reports",
  name: "Team Reports",
  description:
    "Daily, weekly, and monthly team activity reports from GitHub and Discord, with model-written summaries.",
  configSchema: { parse: parseTeamReportsConfig },
  register(api) {
    const initial = parseTeamReportsConfig(
      api.pluginConfig,
      api.config.gateway?.controlUi?.basePath,
    );
    let scheduler: TeamReportsScheduler | undefined;
    let store: TeamReportsStore | undefined;
    const requireScheduler = () => {
      if (!scheduler) {
        throw new Error(
          "Team Reports service is not running; check plugin configuration and reload the plugin",
        );
      }
      return scheduler;
    };
    const requireStore = () => {
      if (!store) {
        throw new Error("Team Reports storage is unavailable; check service status");
      }
      return store;
    };

    api.registerService({
      id: "team-reports",
      apiVersion: 2,
      async start(ctx) {
        const config = parseTeamReportsConfig(
          ctx.config.plugins?.entries?.["team-reports"]?.config ?? api.pluginConfig,
          ctx.config.gateway?.controlUi?.basePath,
        );
        const resolved = await resolveTeamReportsConfig(config, ctx.config);
        const policy = ctx.config.plugins?.entries?.["team-reports"]?.llm;
        const summaryOptions = { ...config.summaries };
        if (policy?.allowModelOverride !== true) {
          delete summaryOptions.model;
        }
        if (!api.runtimeSource) {
          throw new Error(
            "Team Reports requires an OpenClaw host with runtime entrypoint metadata",
          );
        }
        const nextStore = await createTeamReportsStore({
          stateDir: ctx.stateDir,
          workerModuleUrl: new URL(
            `./src/store.worker${path.extname(api.runtimeSource)}`,
            pathToFileURL(api.runtimeSource),
          ),
        });
        const runner = new TeamReportsRunner(
          new URL(
            `./src/run.worker${path.extname(api.runtimeSource)}`,
            pathToFileURL(api.runtimeSource),
          ),
        );
        const nextScheduler = new TeamReportsScheduler({
          config: { ...config, summaries: summaryOptions },
          resolved,
          store: nextStore,
          llm: { complete: (params) => api.runtime.llm.complete(params) },
          context: ctx,
          runReports: (params) => runner.run(params),
          closeRunner: () => runner.close(),
        });
        try {
          await nextScheduler.start();
          store = nextStore;
          scheduler = nextScheduler;
        } catch (error) {
          await nextScheduler.stop();
          throw error;
        }
      },
      async stop() {
        // The host joins startup before stopping this service; the scheduler drains admitted work.
        const current = scheduler;
        scheduler = undefined;
        store = undefined;
        await current?.stop();
      },
    });
    api.registerHttpRoute({
      path: initial.basePath,
      match: "prefix",
      auth: "gateway",
      handler: createTeamReportsHttpHandler({
        basePath: initial.basePath,
        displayTimezone: initial.displayTimezone,
        sessionRouting: () => {
          const config = api.runtime.config.current();
          return {
            controlUiBasePath: config.gateway?.controlUi?.basePath,
            mainKey: config.session?.mainKey,
          };
        },
        workSessions: listWorkSessions,
        // Source checkouts, the flattened dist bundle, and installed packages all keep assets/ at the plugin root.
        assetsDir: path.join(api.rootDir ?? path.dirname(fileURLToPath(import.meta.url)), "assets"),
        getStore: () => store,
        status: () => requireScheduler().status(),
        health: () => requireScheduler().health(),
        orgs: () => scheduler?.orgs() ?? initial.github.orgs,
        people: () => scheduler?.people() ?? initial.people ?? [],
      }),
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "team-reports",
      label: "Reports",
      slug: "reports",
      description: "Team activity reports from GitHub and Discord.",
      icon: "chart",
      group: "control",
      requiredScopes: ["operator.read"],
      path: `${initial.basePath}/`,
    });
    registerTeamReportsGatewayMethods(api, { scheduler: requireScheduler, store: requireStore });
    api.registerCli(
      async ({ program }) => {
        const { registerTeamReportsCli } = await import("./src/cli.js");
        registerTeamReportsCli({ program });
      },
      {
        descriptors: [
          {
            name: "team-reports",
            description: "Read and generate team activity reports",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
