import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import {
  definePluginEntry,
  type OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginRuntimeProcessEntrypoint,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { z } from "zod";
import { parseTeamReportsConfig, resolveTeamReportsConfig } from "./src/config.js";
import { createTeamReportsHttpHandler } from "./src/http.js";
import { describePeriod, periodSchema } from "./src/periods.js";
import { TeamReportsRunner } from "./src/run-worker.js";
import { TeamReportsScheduler } from "./src/scheduler.js";
import { createTeamReportsStore, type TeamReportsStore } from "./src/store.js";
import { listWorkSessions } from "./src/work-sessions.js";

const listSchema = z.strictObject({ period: periodSchema.optional() });
const getSchema = z.strictObject({
  period: periodSchema,
  key: z.string(),
  format: z.enum(["json", "markdown"]).default("json"),
});
const generateSchema = z.strictObject({
  period: z.literal("day"),
  date: z.iso.date().optional(),
  intraday: z.boolean().optional(),
});

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
    let readiness: Promise<void> | undefined;
    const requireScheduler = async () => {
      await readiness;
      if (!scheduler) {
        throw new Error(
          "Team Reports service is not running; check plugin configuration and reload the plugin",
        );
      }
      return scheduler;
    };
    const requireStore = async () => {
      await readiness;
      if (!store) {
        throw new Error("Team Reports storage is unavailable; check service status");
      }
      return store;
    };

    api.registerService({
      id: "team-reports",
      apiVersion: 2,
      async start(ctx) {
        readiness = initialize(ctx);
        void readiness.catch(() => {
          const failure = new Error(
            "Team Reports initialization failed; check plugin configuration and database access",
          );
          ctx.serviceHealth?.reportFailure(failure);
          ctx.logger.error(failure.message);
        });
      },
      async stop(ctx) {
        ctx.scheduler.beginClose();
        await readiness?.catch(() => {});
        readiness = undefined;
        const current = scheduler;
        scheduler = undefined;
        store = undefined;
        await current?.stop();
      },
    });

    async function initialize(ctx: OpenClawPluginServiceContextV2) {
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
        throw new Error("Team Reports requires an OpenClaw host with runtime entrypoint metadata");
      }
      const nextStore = await createTeamReportsStore({
        stateDir: ctx.stateDir,
        workerModuleUrl: resolveRuntimeWorkerUrl(
          createPluginRuntimeProcessEntrypoint(
            "teamReportsStore",
            pathToFileURL(api.runtimeSource).href,
          ),
        ),
      });
      const runner = new TeamReportsRunner(
        resolveRuntimeWorkerUrl(
          createPluginRuntimeProcessEntrypoint(
            "teamReportsRun",
            pathToFileURL(api.runtimeSource).href,
          ),
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
    }
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
        getStore: async () => {
          await readiness?.catch(() => {});
          return store;
        },
        status: async () => (await requireScheduler()).status(),
        health: async () => (await requireScheduler()).health(),
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
    const register = (
      name: string,
      scope: "operator.read" | "operator.admin",
      run: (params: unknown) => Promise<unknown>,
    ) => {
      api.registerGatewayMethod(
        `team-reports.${name}`,
        async ({ params, respond }) => {
          try {
            respond(true, await run(params ?? {}));
          } catch (error) {
            const message = error instanceof Error ? error.message : "Team Reports request failed";
            respond(
              false,
              undefined,
              errorShape(
                error instanceof z.ZodError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
                message,
              ),
            );
          }
        },
        { scope },
      );
    };
    register("status", "operator.read", async (params) => {
      z.strictObject({}).parse(params);
      return (await requireScheduler()).status();
    });
    register("list", "operator.read", async (params) => ({
      periods: await (await requireStore()).listPeriods(listSchema.parse(params)),
    }));
    register("get", "operator.read", async (params) => {
      const { period, key, format } = getSchema.parse(params);
      describePeriod(period, key);
      if (format === "markdown") {
        const stored = await (await requireStore()).getPeriod(period, key);
        if (!stored) {
          throw new Error("Report not found; generate the requested UTC day first");
        }
        return { markdown: stored.markdown };
      }
      const stored = await (await requireStore()).getPeriodDocument(period, key);
      if (!stored) {
        throw new Error("Report not found; generate the requested UTC day first");
      }
      return stored;
    });
    register("generate", "operator.admin", async (params) => ({
      runId: await (await requireScheduler()).generate(generateSchema.parse(params)),
    }));
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
