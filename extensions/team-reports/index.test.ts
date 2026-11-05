import fs from "node:fs";
import paths from "node:path";
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
    config: runtimeConfig,
    register(api) {
      Object.defineProperty(api.runtime, "llm", {
        get() {
          throw new Error("Reports without summaries must not load the LLM runtime");
        },
      });
      plugin.register({
        ...api,
        runtimeSource,
        pluginConfig: api.config.plugins?.entries?.["team-reports"]?.config,
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
  ["extensions/team-reports", "ts", "openclaw"],
  ["dist", "js", "@openclaw/team-reports"],
  ["dist/extensions/team-reports", "js", "openclaw"],
] as const)("locates the %s runtime worker", async (root, extension, packageName) => {
  const fixtureRoot = tempDirs.make("team-reports-worker-layout-");
  const runtimeSource = paths.resolve(fixtureRoot, root, `index.${extension}`);
  fs.writeFileSync(paths.join(fixtureRoot, "package.json"), JSON.stringify({ name: packageName }));
  const { service, methods, context } = captureReports(runtimeSource);
  const stopBeforeOpening = new Error("worker location captured");
  vi.mocked(createTeamReportsStore).mockRejectedValueOnce(stopBeforeOpening);
  await expect(service.start(context)).resolves.toBeUndefined();
  expectUnavailable(await requestReports(methods), { message: stopBeforeOpening.message });
  expect(createTeamReportsStore).toHaveBeenCalledWith({
    stateDir: "unused",
    workerModuleUrl: pathToFileURL(
      paths.resolve(fixtureRoot, root, `src/store.worker.${extension}`),
    ),
  });
});

it("closes owned storage when the service scheduler cannot start", async () => {
  const store = await openStore();
  vi.mocked(createTeamReportsStore).mockResolvedValueOnce(store);
  const { service, methods, scheduler, context } = captureReports();
  await scheduler.stop();
  await expect(service.start(context)).resolves.toBeUndefined();
  expectUnavailable(await requestReports(methods), {
    message: expect.stringContaining("scheduler cannot be started again"),
  });
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

it("registers authenticated reports and read/admin methods without opening storage", () => {
  const { captured, routes, methods } = captureReports();
  expect(
    captured.controlUiDescriptors.map(({ path, requiredScopes }) => [path, requiredScopes]),
  ).toEqual([["/team/activity/", ["operator.read"]]]);
  expect(routes).toMatchObject([{ path: "/team/activity", match: "prefix", auth: "gateway" }]);
  expect(methods.map(([name, , options]) => [name, options?.scope])).toEqual([
    ["team-reports.status", "operator.read"],
    ["team-reports.list", "operator.read"],
    ["team-reports.get", "operator.read"],
    ["team-reports.generate", "operator.admin"],
  ]);
  expect(createTeamReportsStore).not.toHaveBeenCalled();
});

it.each([true, false])("reads stored JSON/Markdown (schedule: %s)", async (enabled) => {
  const store = await openStore();
  vi.mocked(createTeamReportsStore).mockResolvedValueOnce(store);
  const { service, methods, context } = captureReports(undefined, enabled);
  try {
    await expect(service.start(context)).resolves.toBeUndefined();
    const report = reportDocument([]);
    const request = (format: "json" | "markdown") =>
      requestReports(methods, "team-reports.get", {
        period: "day",
        key: report.period.key,
        format,
      });
    for (const format of ["json", "markdown"] as const) {
      expectUnavailable(await request(format), {
        code: "UNAVAILABLE",
        message: "Report not found; generate the requested UTC day first",
      });
    }
    const markdown = "# Stored report\n\né 🦞\0\n";
    await store.upsertPeriod({ report, markdown });
    expect(await request("json")).toHaveBeenCalledWith(true, { report, summary: null });
    expect(await request("markdown")).toHaveBeenCalledWith(true, { markdown });
  } finally {
    await service.stop?.(context);
  }
});
