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
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { describePeriod } from "./src/periods.js";
import { reportDocument } from "./src/reports-data.test-support.js";
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
async function openStore() {
  const actual = await vi.importActual<typeof import("./src/store.js")>("./src/store.js");
  const store = await actual.createTeamReportsStore({
    stateDir: tempDirs.make("team-reports-"),
    workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
  });
  onTestFinished(() => store.close());
  return store;
}

function expectUnavailable(
  respond: Awaited<ReturnType<typeof requestReports>>,
  details: Record<string, unknown>,
) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(details));
}

function captureReports(
  runtimeSource = fileURLToPath(new URL("./index.ts", import.meta.url)),
  enabled?: boolean,
) {
  const runtimeConfig: OpenClawConfig = {
    gateway: { controlUi: { basePath: "/control" } },
    plugins: {
      entries: {
        "team-reports": { enabled: true, config: { ...pluginConfig, schedule: { enabled } } },
      },
    },
  };
  const scheduler = createTestPluginServiceScheduler();
  onTestFinished(() => scheduler.stop());
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const registerHttpRoute = vi.fn<OpenClawPluginApi["registerHttpRoute"]>();
  const registerGatewayMethod = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
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
        registerService: registerService.mockImplementation(api.registerService),
        registerHttpRoute: registerHttpRoute.mockImplementation(api.registerHttpRoute),
        registerGatewayMethod: registerGatewayMethod.mockImplementation(api.registerGatewayMethod),
      });
    },
  });
  return {
    captured,
    scheduler,
    service: registerService.mock.calls[0]![0],
    context: {
      config: runtimeConfig,
      stateDir: "unused",
      scheduler,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      serviceHealth: { reportFailure: vi.fn(), clearFailure: vi.fn() },
    } satisfies OpenClawPluginServiceContextV2,
    services: registerService.mock.calls.map(([service]) => service),
    routes: registerHttpRoute.mock.calls.map(([route]) => route),
    methods: registerGatewayMethod.mock.calls,
  };
}

async function requestReports(
  methods: ReturnType<typeof captureReports>["methods"],
  method = "team-reports.status",
  params: Record<string, unknown> = {},
) {
  const handler = methods.find(([name]) => name === method)![1];
  const respond = vi.fn<Parameters<typeof handler>[0]["respond"]>();
  await handler({
    req: { type: "req", id: "report-read", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    get context(): never {
      throw new Error("Stored report reads do not need Gateway runtime context");
    },
  });
  return respond;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

it.each([
  ["extensions/team-reports", "ts"],
  ["plugins/team-reports/dist", "js"],
  ["dist/extensions/team-reports", "js"],
] as const)("locates the %s runtime worker", async (root, extension) => {
  const runtimeSource = path.resolve(root, `index.${extension}`);
  const { service, methods, context } = captureReports(runtimeSource);
  const stopBeforeOpening = new Error("worker location captured");
  vi.mocked(createTeamReportsStore).mockRejectedValueOnce(stopBeforeOpening);
  await expect(service.start(context)).resolves.toBeUndefined();
  expectUnavailable(await requestReports(methods), { message: stopBeforeOpening.message });
  expect(createTeamReportsStore).toHaveBeenCalledWith({
    stateDir: "unused",
    workerModuleUrl: pathToFileURL(path.resolve(root, `src/store.worker.${extension}`)),
  });
});

it("closes owned storage when the service scheduler cannot start", async () => {
  const store = await openStore();
  const close = vi.spyOn(store, "close");
  vi.mocked(createTeamReportsStore).mockResolvedValueOnce(store);
  const { service, methods, scheduler, context } = captureReports();
  await scheduler.stop();
  await expect(service.start(context)).resolves.toBeUndefined();
  expectUnavailable(await requestReports(methods), {
    message: expect.stringContaining("scheduler cannot be started again"),
  });
  expect(close).toHaveBeenCalledOnce();
  await expect(store.listRuns()).rejects.toThrow("store is closed");
});

it.each([false, true])("joins storage readiness (stop early: %s)", async (stopEarly) => {
  const store = await openStore();
  const opening = Promise.withResolvers<typeof store>();
  vi.mocked(createTeamReportsStore).mockReturnValueOnce(opening.promise);
  const { service, methods, context } = captureReports();
  await service.start(context);
  const replied = vi.fn();
  const stopped = vi.fn();
  const reading = requestReports(methods, "team-reports.list");
  void reading.then(replied);
  const stopping = stopEarly ? Promise.resolve(service.stop?.(context)).then(stopped) : undefined;
  expect([replied.mock.calls, stopped.mock.calls]).toEqual([[], []]);
  opening.resolve(store);
  const respond = await reading;
  if (stopEarly) {
    await stopping;
    expectUnavailable(respond, { code: "UNAVAILABLE" });
    await expect(store.listPeriods()).rejects.toThrow("store is closed");
  } else {
    expect(respond).toHaveBeenCalledWith(true, { periods: [] });
    await service.stop?.(context);
  }
});

it("registers authenticated reports, read/admin methods, and CLI without opening storage", () => {
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
  expect(routes).toMatchObject([
    {
      path: "/team/activity",
      match: "prefix",
      auth: "gateway",
      handler: expect.any(Function),
    },
  ]);
  expect(services).toMatchObject([
    {
      id: "team-reports",
      start: expect.any(Function),
      stop: expect.any(Function),
    },
  ]);
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

it.each([true, false])("reads stored JSON/Markdown (schedule: %s)", async (enabled) => {
  const store = await openStore();
  vi.mocked(createTeamReportsStore).mockResolvedValueOnce(store);
  const { service, methods, context } = captureReports(undefined, enabled);
  try {
    await expect(service.start(context)).resolves.toBeUndefined();
    expect(await store.listPeriods()).toEqual([]);
    const request = async (format: "json" | "markdown") => {
      const respond = await requestReports(methods, "team-reports.get", {
        period: "day",
        key: "2026-08-19",
        format,
      });
      expect(respond).toHaveBeenCalledOnce();
      return respond;
    };
    for (const format of ["json", "markdown"] as const) {
      expectUnavailable(await request(format), {
        code: "UNAVAILABLE",
        message: "Report not found; generate the requested UTC day first",
      });
    }
    const report = reportDocument([], {
      period: describePeriod("day", "2026-08-19"),
      orgs: ["sample"],
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
  }
});
