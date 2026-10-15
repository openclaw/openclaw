import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { aggregateDay } from "./src/aggregate.js";
import * as configRuntime from "./src/config.js";
import { describePeriod } from "./src/periods.js";
import { buildRoster } from "./src/roster.js";
import { teamReportsSqliteBackendEntrypoint } from "./src/sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore } from "./src/store.js";

vi.mock("./src/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/store.js")>()),
  createTeamReportsStore: vi.fn(() => {
    throw new Error("Registration must not open report storage");
  }),
}));

import plugin from "./index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const pluginConfig = {
  basePath: "/team/activity/",
  github: { token: "fixture-github-token", orgs: ["sample"] },
  summaries: { enabled: false },
};
const config: OpenClawConfig = {
  gateway: { controlUi: { basePath: "/control" } },
  plugins: { entries: { "team-reports": { enabled: true, config: pluginConfig } } },
};

function captureReports(
  runtimeSource = fileURLToPath(new URL("./index.ts", import.meta.url)),
  runtimeConfig = config,
) {
  const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
  const scheduler = createTestPluginServiceScheduler();
  onTestFinished(() => scheduler.stop());
  const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
  const methods: Array<Parameters<OpenClawPluginApi["registerGatewayMethod"]>> = [];
  const captured = capturePluginRegistration({
    id: plugin.id,
    name: plugin.name,
    config: runtimeConfig,
    register(api) {
      plugin.register({
        ...api,
        runtimeSource,
        pluginConfig: api.config.plugins?.entries?.["team-reports"]?.config,
        runtime: new Proxy(api.runtime, {
          get(target, key, receiver) {
            if (key === "llm") {
              throw new Error("Reports without summaries must not load the LLM runtime");
            }
            return Reflect.get(target, key, receiver);
          },
        }),
        registerService(service) {
          services.push(service);
          api.registerService(service);
        },
        registerHttpRoute(route) {
          routes.push(route);
          api.registerHttpRoute(route);
        },
        registerGatewayMethod(...args) {
          methods.push(args);
          api.registerGatewayMethod(...args);
        },
      });
    },
  });
  return { captured, services, routes, methods, scheduler };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("Team Reports registration", () => {
  it.each([
    ["source", "extensions/team-reports/index.ts", "extensions/team-reports/src/store.worker.ts"],
    [
      "standalone",
      "plugins/team-reports/dist/index.js",
      "plugins/team-reports/dist/src/store.worker.js",
    ],
    [
      "bundled",
      "dist/extensions/team-reports/index.js",
      "dist/extensions/team-reports/src/store.worker.js",
    ],
  ] as const)(
    "locates its %s worker from the selected runtime entry",
    async (_layout, entry, worker) => {
      const runtimeSource = path.resolve(entry);
      const { services, scheduler } = captureReports(runtimeSource);
      const parsed = configRuntime.parseTeamReportsConfig(pluginConfig);
      vi.spyOn(configRuntime, "resolveTeamReportsConfig").mockResolvedValue({
        github: { ...parsed.github, token: "fixture-github-token", ignoreCommentPatterns: [] },
        people: [],
      });
      const stopBeforeOpening = new Error("worker location captured");
      vi.mocked(createTeamReportsStore).mockRejectedValueOnce(stopBeforeOpening);
      await expect(
        services[0]!.start({ config, stateDir: "/unused", logger: console, scheduler }),
      ).rejects.toBe(stopBeforeOpening);
      expect(createTeamReportsStore).toHaveBeenCalledWith({
        config,
        stateDir: "/unused",
        workerModuleUrl: pathToFileURL(path.resolve(worker)),
      });
    },
  );

  it("closes owned storage when the service scheduler cannot start", async () => {
    const directory = tempDirs.make("team-reports-failed-start-");
    const { createTeamReportsStore: openStore } =
      await vi.importActual<typeof import("./src/store.js")>("./src/store.js");
    const store = await openStore({
      stateDir: directory,
      workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
    });
    onTestFinished(() => store.close());
    const close = vi.spyOn(store, "close");
    vi.mocked(createTeamReportsStore).mockResolvedValueOnce(store);
    const parsed = configRuntime.parseTeamReportsConfig(pluginConfig);
    vi.spyOn(configRuntime, "resolveTeamReportsConfig").mockResolvedValue({
      github: { ...parsed.github, token: "fixture-github-token", ignoreCommentPatterns: [] },
      people: [],
    });
    const { services, scheduler } = captureReports();
    const service = services[0]!;
    await scheduler.stop();
    await expect(
      service.start({ config, stateDir: directory, logger: console, scheduler }),
    ).rejects.toThrow("scheduler cannot be started again");
    expect(close).toHaveBeenCalledOnce();
    await expect(store.listRuns()).rejects.toThrow("store is closed");
  });

  it("exposes reports through the authenticated tab, read methods, and admin generation method", () => {
    const { captured, services, routes, methods } = captureReports();
    expect(captured.controlUiDescriptors).toEqual([
      {
        surface: "tab",
        id: "team-reports",
        label: "Reports",
        slug: "reports",
        description: "Team activity reports from GitHub and Discord.",
        icon: "chart",
        group: "control",
        requiredScopes: ["operator.read"],
        path: "/team/activity/",
      },
    ]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: "/team/activity",
      match: "prefix",
      auth: "gateway",
      handler: expect.any(Function),
    });
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      id: "team-reports",
      start: expect.any(Function),
      stop: expect.any(Function),
    });
    expect(methods.map(([name, , options]) => [name, options?.scope])).toEqual([
      ["team-reports.status", "operator.read"],
      ["team-reports.list", "operator.read"],
      ["team-reports.get", "operator.read"],
      ["team-reports.generate", "operator.admin"],
    ]);
    expect(captured.cliRegistrars).toMatchObject([
      {
        parentPath: [],
        commands: ["team-reports"],
        descriptors: [
          {
            name: "team-reports",
            description: "Read and generate team activity reports",
            hasSubcommands: true,
          },
        ],
      },
    ]);
    expect(createTeamReportsStore).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "serves stored JSON and Markdown with scheduling enabled=%s",
    async (enabled) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-reports-lazy-llm-"));
      const actual = await vi.importActual<typeof import("./src/store.js")>("./src/store.js");
      const store = await actual.createTeamReportsStore({
        stateDir: directory,
        workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
      });
      vi.mocked(createTeamReportsStore).mockResolvedValueOnce(store);
      const runtimeConfig: OpenClawConfig = {
        ...config,
        plugins: {
          entries: {
            "team-reports": {
              enabled: true,
              config: { ...pluginConfig, schedule: { enabled } },
            },
          },
        },
      };
      const { services, methods, scheduler } = captureReports(undefined, runtimeConfig);
      const service = services[0]!;
      const context: OpenClawPluginServiceContextV2 = {
        scheduler,
        config: runtimeConfig,
        stateDir: directory,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };
      try {
        await expect(service.start(context)).resolves.toBeUndefined();
        expect(await store.listPeriods()).toEqual([]);
        const handler = methods.find(([name]) => name === "team-reports.get")?.[1];
        if (!handler) {
          throw new Error("Team Reports must register its get method");
        }
        const request = async (format: "json" | "markdown") => {
          const params = { period: "day", key: "2026-08-19", format };
          const respond = vi.fn<Parameters<typeof handler>[0]["respond"]>();
          await handler({
            req: { type: "req", id: "report-read", method: "team-reports.get", params },
            params,
            client: null,
            isWebchatConnect: () => false,
            respond,
            get context(): never {
              throw new Error("Stored report reads do not need Gateway runtime context");
            },
          });
          expect(respond).toHaveBeenCalledOnce();
          return respond;
        };
        for (const format of ["json", "markdown"] as const) {
          expect(await request(format)).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: "UNAVAILABLE",
              message: "Report not found; generate the requested UTC day first",
            }),
          );
        }
        const report = aggregateDay({
          period: describePeriod("day", "2026-08-19"),
          nowMs: Date.parse("2026-08-20T00:00:00Z"),
          orgs: ["sample"],
          roster: buildRoster([]),
          items: [],
          messages: [],
          githubStatus: { ok: true, warnings: [], stats: {} },
        });
        const summary = {
          source: "fallback" as const,
          generatedAtMs: report.generatedAtMs,
          globalSummary: "No recorded activity.",
          highlights: [],
          fingerprint: "stored-summary",
        };
        const markdown = "# Stored report\n\né 🦞\0\n";
        await store.upsertPeriod({ report, summary, markdown });
        expect(await request("json")).toHaveBeenCalledWith(true, { report, summary });
        expect(await request("markdown")).toHaveBeenCalledWith(true, { markdown });
        await store.upsertPeriod({ report, markdown: "Updated report" });
        expect(await request("json")).toHaveBeenCalledWith(true, { report, summary: null });
        expect(await request("markdown")).toHaveBeenCalledWith(true, {
          markdown: "Updated report",
        });
      } finally {
        await service.stop?.(context);
        await store.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
