import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withServer } from "openclaw/plugin-sdk/test-env";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QaLabRunSelection, QaLabRunnerSnapshot } from "../runner-contract.js";
import { writeQaLabSuiteResultFixture } from "./lab-server-suite.test-support.js";
import { resolveUiAssetVersion } from "./lab-server-ui.js";
import { startQaLabServer, type QaLabServerStartParams } from "./lab-server.js";
import * as runConfig from "./run-config.js";
import * as selfCheck from "./self-check.js";
import * as suiteSummary from "./suite-summary.js";

const qaChannelMock = vi.hoisted(() => ({
  resolveAccount: vi.fn(),
  setRuntime: vi.fn(),
  startAccount: vi.fn(),
}));

const suiteLaunchMock = vi.hoisted(() => ({
  runQaSuite: vi.fn(),
}));
const liveTransportMock = vi.hoisted(() => ({
  adapterFactories: [{ id: "live-test-factory", matches: vi.fn(), create: vi.fn() }],
  listAdapterFactories: vi.fn(),
}));

vi.mock("./suite-launch.runtime.js", () => ({
  runQaSuite: suiteLaunchMock.runQaSuite,
}));

vi.mock("./live-transports/cli.js", () => ({
  listLiveTransportQaAdapterFactories: liveTransportMock.listAdapterFactories,
}));

vi.mock("openclaw/plugin-sdk/qa-channel", () => ({
  qaChannelPlugin: {
    config: {
      resolveAccount: qaChannelMock.resolveAccount,
    },
    gateway: {
      startAccount: qaChannelMock.startAccount,
    },
  },
  setQaChannelRuntime: qaChannelMock.setRuntime,
}));

const captureMock = await vi.hoisted(async () => {
  const { createQaLabCaptureMock } = await import("./lab-server-capture.test-support.js");
  return createQaLabCaptureMock();
});

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  acquireDebugProxyCaptureStoreAsync: captureMock.acquire,
  resolveDebugProxySettings: () => ({
    proxyUrl: process.env.OPENCLAW_DEBUG_PROXY_URL ?? "",
    sessionId: "qa-lab-test",
  }),
}));

const cleanups: Array<() => Promise<void>> = [];
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeRepoFile(root: string, file: string, content: string) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return target;
}

async function postLabJson(baseUrl: string, route: string, body: unknown) {
  return fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function startLab(params?: QaLabServerStartParams) {
  const lab = await startQaLabServer({ embeddedGateway: "disabled", ...params });
  cleanups.push(() => lab.stop());
  return lab;
}

async function startStoppableLab(params?: QaLabServerStartParams) {
  const lab = await startLab(params);
  const stopServer = lab.stop;
  let stopping: Promise<void> | undefined;
  lab.stop = () => (stopping ??= stopServer());
  return lab;
}

function postBaselineSuite(baseUrl: string, overrides?: Partial<QaLabRunSelection>) {
  return postLabJson(baseUrl, "/api/scenario/suite", {
    channelDriver: "crabline",
    providerMode: "live-frontier",
    scenarioIds: ["dm-chat-baseline"],
    ...overrides,
  });
}

async function expectSuiteLaunch(expected: Record<string, unknown>) {
  await vi.waitFor(() => expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledTimes(1));
  expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledWith(expect.objectContaining(expected));
}

async function getLabJson<T>(baseUrl: string, route: string): Promise<T> {
  const response = await fetchWithRetry(`${baseUrl}${route}`);
  expect(response.status).toBe(200);
  return response.json();
}

function deferSelfCheck() {
  const entered = Promise.withResolvers<void>();
  const finish =
    Promise.withResolvers<Awaited<ReturnType<typeof selfCheck.runQaSelfCheckAgainstState>>>();
  const spy = vi.spyOn(selfCheck, "runQaSelfCheckAgainstState").mockImplementation(() => {
    entered.resolve();
    return finish.promise;
  });
  return { entered, finish, spy };
}

type Bootstrap = {
  controlUiUrl: string | null;
  controlUiEmbeddedUrl: string | null;
  kickoffTask: string;
  defaults: { conversationId: string; senderId: string };
  scenarios: Array<{ id: string; title: string; execution?: { kind?: string } }>;
  latestReport: { outputPath: string; markdown: string } | null;
  runner: QaLabRunnerSnapshot;
  runnerCatalog: {
    status: "loading" | "ready" | "failed";
    real: Array<{ key: string; name: string }>;
    channels: string[];
    profiles: Array<{ id: string }>;
  };
};

async function readBootstrap(baseUrl: string): Promise<Bootstrap> {
  return getLabJson<Bootstrap>(baseUrl, "/api/bootstrap");
}

async function expectBootstrap(baseUrl: string, expected: Record<string, unknown>) {
  await vi.waitFor(async () => expect(await readBootstrap(baseUrl)).toMatchObject(expected));
}

async function suiteResult(params?: Parameters<typeof writeQaLabSuiteResultFixture>[1]) {
  return writeQaLabSuiteResultFixture(await makeTempDir("qa-lab-suite-result-"), params);
}

function resolveSuite(result: Awaited<ReturnType<typeof suiteResult>>, executionKind = "flow") {
  suiteLaunchMock.runQaSuite.mockResolvedValue({
    executionKind,
    expectedCells: [],
    observedCells: [],
    result,
  });
}

beforeEach(() => {
  captureMock.reset();
  suiteLaunchMock.runQaSuite.mockReset();
  liveTransportMock.listAdapterFactories.mockReset();
  liveTransportMock.listAdapterFactories.mockReturnValue(liveTransportMock.adapterFactories);
  liveTransportMock.adapterFactories[0]!.matches.mockReset();
  qaChannelMock.resolveAccount.mockReset();
  qaChannelMock.resolveAccount.mockImplementation((_cfg: unknown, accountId: string) => ({
    accountId,
    configured: true,
    enabled: true,
  }));
  qaChannelMock.setRuntime.mockReset();
  qaChannelMock.startAccount.mockReset();
  qaChannelMock.startAccount.mockImplementation(
    async ({ abortSignal }: { abortSignal?: AbortSignal }) =>
      await new Promise<void>((resolve) => {
        if (!abortSignal || abortSignal.aborted) {
          resolve();
          return;
        }
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
});

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function isRetryableLocalFetchError(error: unknown) {
  if (!(error instanceof TypeError)) {
    return false;
  }
  const cause = error.cause;
  if (!cause || typeof cause !== "object") {
    return false;
  }
  const code = "code" in cause ? cause.code : undefined;
  return code === "ECONNRESET" || code === "UND_ERR_SOCKET";
}

async function fetchWithRetry(input: string, init?: RequestInit) {
  const method = init?.method?.toUpperCase() ?? "GET";
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (
        attempt === 3 ||
        (method !== "GET" && method !== "HEAD") ||
        !isRetryableLocalFetchError(error)
      ) {
        throw error;
      }
      await sleep(10);
    }
  }
}

async function waitForRunnerCatalog(baseUrl: string, timeoutMs = 5_000) {
  let catalog: Bootstrap["runnerCatalog"] | undefined;
  await vi.waitFor(
    async () => {
      const bootstrap = await readBootstrap(baseUrl);
      if (bootstrap.runnerCatalog.status === "loading") {
        throw new Error("runner catalog still loading");
      }
      catalog = bootstrap.runnerCatalog;
    },
    { interval: 1, timeout: timeoutMs },
  );
  if (!catalog) {
    throw new Error("runner catalog stayed loading");
  }
  return catalog;
}

async function expectFileMissing(filePath: string): Promise<void> {
  await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}

async function createQaLabRepoRootFixture(params?: {
  uiHtml?: string;
  models?: Array<{ key: string; name: string }>;
}) {
  const repoRoot = await makeTempDir("qa-lab-repo-root-");
  const models =
    params?.models?.map((model) => ({
      key: model.key,
      name: model.name,
      input: model.key,
      available: true,
      missing: false,
    })) ?? [];
  await writeRepoFile(
    repoRoot,
    "dist/index.js",
    `process.stdout.write(${JSON.stringify(JSON.stringify({ models }))});\n`,
  );
  await writeRepoFile(
    repoRoot,
    "extensions/qa-lab/web/dist/index.html",
    params?.uiHtml ?? "<!doctype html><html><body>qa lab fixture</body></html>",
  );
  return repoRoot;
}

async function writeEvidenceFixture(
  evidenceDir: string,
  id: string,
  artifactPaths: string[],
  artifactKind = "log",
) {
  await writeFile(
    path.join(evidenceDir, "qa-evidence.json"),
    JSON.stringify({
      kind: "openclaw.qa.evidence-summary",
      schemaVersion: 2,
      generatedAt: "2026-06-17T12:00:00.000Z",
      evidenceMode: "full",
      entries: [
        {
          test: { kind: "vitest-test", id, title: id },
          coverage: [{ id: "qa.artifact", role: "primary" }],
          execution: {
            runner: "vitest",
            environment: { ref: "server-test", os: process.platform, nodeVersion: process.version },
            provider: {
              id: "mock-openai",
              live: false,
              model: { name: "mock-openai/gpt-5.6-luna", ref: "mock-openai/gpt-5.6-luna" },
            },
            packageSource: { kind: "source-checkout" },
            artifacts: artifactPaths.map((artifactPath) => ({
              kind: artifactKind,
              path: artifactPath,
              source: "vitest",
            })),
          },
          result: { status: "pass" },
        },
      ],
    }),
    "utf8",
  );
}

describe("qa-lab server", () => {
  it("returns reachable IPv6 listen and advertised URLs", async () => {
    const lab = await startLab({ host: "::1", port: 0 });

    for (const baseUrl of [lab.listenUrl, lab.baseUrl]) {
      const response = await fetch(`${baseUrl}/healthz`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, status: "live" });
    }
  });

  it("returns a 500 JSON response when a shared bus route rejects", async () => {
    const lab = await startLab();
    const requestError = new Error("combined snapshot unavailable");
    lab.state.getSnapshot = () => {
      throw requestError;
    };

    const response = await fetch(`${lab.baseUrl}/v1/state`, {
      signal: AbortSignal.timeout(1_000),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: requestError.message });
  });

  it.each<{
    name: string;
    selection: Partial<QaLabRunSelection>;
    launch: Record<string, unknown>;
    plan?: unknown;
    kind?: string;
    watchUrl?: string;
    completed?: Record<string, unknown>;
    useLabWatchUrl?: boolean;
    adapterCalls?: number;
    matchingAdapter?: boolean;
  }>([
    {
      name: "dispatches explicit mixed-kind selections through the suite planner",
      selection: {
        channelDriver: "crabline",
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      },
      kind: "suite",
      plan: {
        executionKinds: ["flow", "playwright"],
        selectedScenarios: [
          { id: "dm-chat-baseline", declaredChannel: null, effectiveChannel: "telegram" },
          { id: "browser-talk-start-stop", declaredChannel: null, effectiveChannel: null },
        ],
      },
      launch: {
        alternateModel: "openai/gpt-5.6-luna",
        channelDriver: "crabline",
        controlUiEnabled: true,
        primaryModel: "openai/gpt-5.6-luna",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      },
      adapterCalls: 0,
      completed: { selection: { scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"] } },
    },
    {
      name: "keeps mock providers independent from real channel adapters",
      selection: {
        channelDriver: "live",
        providerMode: "mock-openai",
        scenarioIds: ["dm-chat-baseline"],
      },
      watchUrl: "http://runtime-watch.invalid",
      launch: {
        adapterFactories: liveTransportMock.adapterFactories,
        channelDriver: "live",
        providerMode: "mock-openai",
      },
      adapterCalls: 1,
      completed: {},
    },
    {
      name: "launches a plural-only catalog scenario on its selected live channel",
      matchingAdapter: true,
      selection: {
        profile: "all",
        channel: "buzz",
        channelDriver: "live",
        providerMode: "mock-openai",
        scenarioIds: ["channel-canary"],
      },
      plan: {
        selectedScenarios: [
          { id: "channel-canary", declaredChannel: null, effectiveChannel: "buzz" },
        ],
      },
      launch: { channelDriver: "live", channelId: "buzz", scenarioIds: ["channel-canary"] },
    },
    {
      name: "returns the resolved runtime-pair-lane plan and launches it with independent live transport",
      matchingAdapter: true,
      useLabWatchUrl: true,
      selection: {
        profile: "all",
        channel: "telegram",
        channelDriver: "live",
        evidenceMode: "slim",
        providerMode: "mock-openai",
        runtimePair: ["openclaw", "codex"],
        runtimePairLane: "core",
      },
      plan: {
        executionKinds: ["flow"],
        selectedScenarios: expect.arrayContaining([
          expect.objectContaining({ id: "runtime-first-hour-20-turn" }),
        ]),
        exclusions: expect.arrayContaining([
          expect.objectContaining({ scenarioId: "codex-plugin-cold-install" }),
        ]),
      },
      launch: {
        adapterFactories: liveTransportMock.adapterFactories,
        channelDriver: "live",
        channelId: "telegram",
        evidenceMode: "slim",
        providerMode: "mock-openai",
        runtimePair: ["openclaw", "codex"],
      },
    },
  ])("$name", async (fixture) => {
    if (fixture.matchingAdapter) {
      liveTransportMock.adapterFactories[0]!.matches.mockReturnValue(true);
    }
    const lab = await startLab();
    const result = await suiteResult(
      fixture.watchUrl
        ? { watchUrl: fixture.watchUrl }
        : fixture.useLabWatchUrl
          ? { watchUrl: lab.baseUrl }
          : undefined,
    );
    resolveSuite(result, fixture.kind);
    const response = await postLabJson(lab.baseUrl, "/api/scenario/suite", fixture.selection);
    expect(response.status).toBe(202);
    if (fixture.plan) {
      expect(await response.json()).toMatchObject({ plan: fixture.plan });
    }
    await expectSuiteLaunch(fixture.launch);
    if (fixture.adapterCalls !== undefined) {
      expect(liveTransportMock.listAdapterFactories).toHaveBeenCalledTimes(fixture.adapterCalls);
    }
    if (fixture.completed) {
      await expectBootstrap(lab.baseUrl, {
        runner: {
          status: "completed",
          artifacts: { watchUrl: fixture.watchUrl ?? lab.baseUrl },
          ...fixture.completed,
        },
      });
    }
  });

  it.each<{
    name: string;
    scenarios?: NonNullable<Parameters<typeof suiteResult>[0]>["scenarios"];
    summary?: string;
    implicit?: boolean;
    expectedError: string | null;
    fullArtifacts?: boolean;
  }>([
    {
      name: "marks failed suite results failed while preserving generated artifacts",
      scenarios: [{ name: "Channel chat baseline", status: "fail", steps: [] }],
      expectedError: "QA suite reported 1 failed or skipped scenario(s).",
      fullArtifacts: true,
    },
    {
      name: "marks skipped suite results failed while preserving generated artifacts",
      scenarios: [{ name: "Channel chat baseline", status: "skip", steps: [] }],
      expectedError: "QA suite reported 1 failed or skipped scenario(s).",
      fullArtifacts: true,
    },
    {
      name: "fails closed on an invalid suite summary while preserving artifacts",
      summary: "{invalid-summary",
      expectedError: "Could not parse QA summary JSON",
    },
    {
      name: "fails closed on an empty suite summary while preserving artifacts",
      summary: JSON.stringify({
        run: { status: "completed" },
        counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
        scenarios: [],
      }),
      expectedError: "did not include any executed scenarios",
    },
    {
      name: "keeps implicit suites green for catalog-verified report-only optional skips",
      implicit: true,
      expectedError: null,
      scenarios: [
        { name: "Channel chat baseline", status: "pass", steps: [] },
        {
          name: "Runtime tool fixture — image_generate",
          status: "skip",
          steps: [],
          details: "image_generate mock provider report-only: tool unavailable",
        },
      ],
    },
  ])("$name", async (fixture) => {
    const lab = await startLab();
    const result = await suiteResult({ scenarios: fixture.scenarios });
    if (fixture.summary) {
      await writeFile(result.summaryPath, fixture.summary, "utf8");
    }
    resolveSuite(result);
    const response = await (fixture.implicit
      ? postLabJson(lab.baseUrl, "/api/scenario/suite", {
          profile: "all",
          channelDriver: "crabline",
          providerMode: "live-frontier",
        })
      : postBaselineSuite(lab.baseUrl));
    expect(response.status).toBe(202);
    await expectBootstrap(lab.baseUrl, {
      runner: {
        status: fixture.expectedError === null ? "completed" : "failed",
        error:
          fixture.fullArtifacts || fixture.expectedError === null
            ? fixture.expectedError
            : expect.stringContaining(fixture.expectedError),
        ...(fixture.fullArtifacts
          ? {
              artifacts: {
                outputDir: result.outputDir,
                evidencePath: result.evidencePath,
                reportPath: result.reportPath,
                summaryPath: result.summaryPath,
              },
            }
          : fixture.summary
            ? { artifacts: { summaryPath: result.summaryPath } }
            : {}),
      },
      ...(fixture.fullArtifacts
        ? { latestReport: { outputPath: result.reportPath, markdown: result.report } }
        : {}),
    });
  });

  it("serializes self-check admission and drains accepted work before stopping the bus", async ({
    signal,
  }) => {
    const { entered, finish, spy } = deferSelfCheck();
    using _ = spy;
    const lab = await startStoppableLab();
    const request = postLabJson(lab.baseUrl, "/api/scenario/self-check", {});
    void request.catch(() => undefined);
    const result: Awaited<ReturnType<typeof selfCheck.runQaSelfCheckAgainstState>> = {
      outputPath: "self-check.md",
      report: "Self-check executor completed.",
      checks: [{ name: "Fixture execution", status: "pass" }],
      scenarioResult: { name: "Fixture execution", status: "pass", steps: [] },
    };

    const stop = lab.stop;
    const admissionRoutes = [
      "/api/reset",
      "/v1/reset",
      "/api/scenario/self-check",
      "/api/scenario/suite",
    ];
    let stopped = false;
    try {
      await withinTest(entered.promise, signal);
      for (const route of admissionRoutes) {
        const response = await withinTest(
          postLabJson(lab.baseUrl, route, { scenarioIds: ["dm-chat-baseline"] }),
          signal,
        );
        await response.json();
        expect(response.status).toBe(409);
      }
      await expect(withinTest(lab.runSelfCheck(), signal)).rejects.toThrow(
        "QA run already in progress",
      );
      const stoppedRun = stop().then(() => {
        stopped = true;
      });
      void stoppedRun.catch(() => undefined);
      const outbound = await postLabJson(lab.baseUrl, "/v1/outbound/message", {
        to: "dm:qa-operator",
        text: "accepted self-check still delivering",
      });
      expect(outbound.status).toBe(200);
      expect(await outbound.json()).toMatchObject({
        message: { direction: "outbound", text: "accepted self-check still delivering" },
      });
      expect(stopped).toBe(false);
      await expect(withinTest(lab.runSelfCheck(), signal)).rejects.toThrow("QA Lab is stopping");
      for (const route of admissionRoutes) {
        const response = await postLabJson(lab.baseUrl, route, {});
        expect(response.status).toBe(503);
        await response.json();
      }
      finish.resolve(result);
      const response = await withinTest(request, signal);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ report: "Self-check executor completed." });
      await withinTest(stoppedRun, signal);
      expect(stopped).toBe(true);
    } finally {
      finish.resolve(result);
      const response = await withinTest(request, signal);
      if (!response.bodyUsed) {
        await response.arrayBuffer();
      }
      await withinTest(stop(), signal);
    }
  });

  it("closes the lab after an accepted self-check rejects during shutdown", async ({ signal }) => {
    const { entered, finish, spy } = deferSelfCheck();
    using _ = spy;
    const lab = await startStoppableLab();
    const request = postLabJson(lab.baseUrl, "/api/scenario/self-check", {});
    void request.catch(() => undefined);
    const stop = lab.stop;
    const failure = new Error("self-check executor failed");
    try {
      await withinTest(entered.promise, signal);
      const stopped = stop();
      void stopped.catch(() => undefined);
      finish.reject(failure);
      const response = await withinTest(request, signal);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "self-check executor failed" });
      await expect(withinTest(stopped, signal)).resolves.toBeUndefined();
      await expect(fetch(`${lab.baseUrl}/healthz`)).rejects.toThrow();
    } finally {
      finish.reject(failure);
      const response = await withinTest(request, signal);
      if (!response.bodyUsed) {
        await response.arrayBuffer();
      }
      await withinTest(stop(), signal);
    }
  });

  it("serializes suite admission and drains accepted work before stopping the bus", async ({
    signal,
  }) => {
    const summaryValidated = Promise.withResolvers<number>();
    const readSummary = suiteSummary.readQaSuiteFailedOrSkippedScenarioCountFromFile;
    using _ = vi
      .spyOn(suiteSummary, "readQaSuiteFailedOrSkippedScenarioCountFromFile")
      .mockImplementation((...args) => {
        const validation = readSummary(...args);
        // Returning the same promise lets the server publish status before this test resumes.
        void validation.then(summaryValidated.resolve, summaryValidated.reject);
        return validation;
      });
    const modelCatalog = await import("./model-catalog.runtime.js");
    using catalog = vi.spyOn(modelCatalog, "loadQaRunnerModelOptions").mockResolvedValue([]);
    const lab = await startStoppableLab();
    const stop = lab.stop;
    const finishSuite = Promise.withResolvers<unknown>();
    suiteLaunchMock.runQaSuite.mockReturnValue(finishSuite.promise);
    const request = () => postBaselineSuite(lab.baseUrl);

    const responses = await Promise.all([request(), request()]);

    expect(
      responses.map((response) => response.status).toSorted((left, right) => left - right),
    ).toEqual([202, 409]);
    expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledTimes(1);
    const result = {
      executionKind: "flow",
      expectedCells: [],
      observedCells: [],
      result: await suiteResult(),
    };
    let stopped = false;
    const stoppedRun = stop().then(() => {
      stopped = true;
    });
    try {
      const outbound = await postLabJson(lab.baseUrl, "/v1/outbound/message", {
        to: "dm:qa-operator",
        text: "accepted suite still delivering",
      });
      expect(outbound.status).toBe(200);
      expect(await outbound.json()).toMatchObject({
        message: { direction: "outbound", text: "accepted suite still delivering" },
      });
      expect(stopped).toBe(false);
      const bootstrap = await fetch(`${lab.baseUrl}/api/bootstrap`);
      expect(bootstrap.status).toBe(200);
      await bootstrap.json();
      expect(catalog).not.toHaveBeenCalled();
      for (const route of ["/api/reset", "/api/scenario/self-check", "/api/scenario/suite"]) {
        const response = await postLabJson(lab.baseUrl, route, {});
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ error: "QA Lab is stopping" });
      }
    } finally {
      finishSuite.resolve(result);
      await withinTest(summaryValidated.promise, signal);
      await withinTest(stoppedRun, signal);
    }
    expect(stopped).toBe(true);
    await expect(fetch(`${lab.baseUrl}/healthz`)).rejects.toThrow();
  });

  it("rejects empty and unknown explicit selections before dispatch", async () => {
    const lab = await startLab();
    for (const scenarioIds of [[], ["missing-scenario"]]) {
      const response = await postLabJson(lab.baseUrl, "/api/scenario/suite", { scenarioIds });
      expect(response.status).toBe(400);
    }
    expect(suiteLaunchMock.runQaSuite).not.toHaveBeenCalled();
  });

  it("returns explicit exclusions and errors without launching unsupported execution kinds", async () => {
    const lab = await startLab();

    const response = await postLabJson(lab.baseUrl, "/api/scenario/suite", {
      profile: "all",
      channelDriver: "qa-channel",
      providerMode: "live-frontier",
      runtimePair: ["openclaw", "codex"],
      scenarioIds: ["browser-talk-start-stop"],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Explicit QA scenario selection is not runnable"),
      plan: {
        status: "invalid",
        exclusions: [
          {
            scenarioId: "browser-talk-start-stop",
            reasons: ["runtimePair requires execution.kind=flow"],
          },
        ],
      },
    });
    expect(suiteLaunchMock.runQaSuite).not.toHaveBeenCalled();
  });

  it("enforces explicit execution.channel through the shared suite channel planner", async () => {
    const lab = await startLab();

    const response = await postLabJson(lab.baseUrl, "/api/scenario/suite", {
      profile: "all",
      channel: "telegram",
      channelDriver: "crabline",
      providerMode: "live-frontier",
      scenarioIds: ["matrix-room-block-streaming"],
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      plan: { exclusions: Array<{ scenarioId: string; reasons: string[] }> };
    };
    expect(payload.plan.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scenarioId: "matrix-room-block-streaming" }),
      ]),
    );
    expect(suiteLaunchMock.runQaSuite).not.toHaveBeenCalled();
  });

  it("does not open capture state when embedded gateway setup fails", async () => {
    qaChannelMock.resolveAccount.mockImplementationOnce(() => {
      throw new Error("embedded setup failed");
    });

    await expect(
      startQaLabServer({
        host: "127.0.0.1",
        port: 0,
      }),
    ).rejects.toThrow("embedded setup failed");

    expect(captureMock.acquire).not.toHaveBeenCalled();
    expect(captureMock.store.close).not.toHaveBeenCalled();
  });

  it("closes the server and acquired capture state when embedded gateway stop fails", async () => {
    qaChannelMock.startAccount.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        await new Promise<void>((_resolve, reject) => {
          if (!abortSignal) {
            return;
          }
          if (abortSignal.aborted) {
            reject(new Error("gateway stop failed"));
            return;
          }
          abortSignal.addEventListener("abort", () => reject(new Error("gateway stop failed")), {
            once: true,
          });
        }),
    );

    const lab = await startQaLabServer({
      host: "127.0.0.1",
      port: 0,
    });
    await fetchWithRetry(`${lab.baseUrl}/api/capture/sessions`);

    await expect(lab.stop()).rejects.toThrow("gateway stop failed");

    expect(captureMock.acquire).toHaveBeenCalledTimes(1);
    expect(captureMock.store.close).toHaveBeenCalledTimes(1);
    await expect(fetch(`${lab.baseUrl}/healthz`)).rejects.toThrow();
  });

  it("keeps the bus available during shutdown and rejects a suite whose plan resolves after stop", async () => {
    const gatewayStopping = Promise.withResolvers<void>();
    const gatewayStopped = Promise.withResolvers<void>();
    qaChannelMock.startAccount.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        gatewayStopping.resolve();
        await gatewayStopped.promise;
      },
    );

    const lab = await startQaLabServer({ host: "127.0.0.1", port: 0 });
    const waitForCursorAdvance = lab.state.waitForCursorAdvance.bind(lab.state);
    let pollWaiterStarted = false;
    let pollWaiterSettled = false;
    lab.state.waitForCursorAdvance = async (...args) => {
      pollWaiterStarted = true;
      try {
        return await waitForCursorAdvance(...args);
      } finally {
        pollWaiterSettled = true;
      }
    };
    const poll = postLabJson(lab.listenUrl, "/v1/poll", {
      accountId: "cleanup",
      cursor: 0,
      timeoutMs: 30_000,
    }).catch(() => undefined);
    const inboundBody = JSON.stringify({
      conversation: { id: "late-room", kind: "direct" },
      senderId: "late-sender",
      text: "must not survive shutdown",
    });
    const slowInbound = httpRequest(new URL("/api/inbound/message", lab.listenUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(inboundBody),
      },
    });
    slowInbound.on("response", (response) => response.resume());
    slowInbound.on("error", () => undefined);
    slowInbound.write(inboundBody.slice(0, 1));
    await vi.waitFor(() => expect(pollWaiterStarted).toBe(true));
    let stopping: Promise<void> | undefined;
    const resolvePlan = runConfig.resolveQaLabRunPlan;
    using _ = vi.spyOn(runConfig, "resolveQaLabRunPlan").mockImplementationOnce((...args) => {
      stopping = lab.stop();
      return resolvePlan(...args);
    });
    const suiteResponse = postLabJson(lab.baseUrl, "/api/scenario/suite", {
      channelDriver: "qa-channel",
      providerMode: "mock-openai",
      scenarioIds: ["dm-chat-baseline"],
    });
    await gatewayStopping.promise;
    try {
      expect((await suiteResponse).status).toBe(503);
      expect(suiteLaunchMock.runQaSuite).not.toHaveBeenCalled();
      await expect(fetch(`${lab.baseUrl}/healthz`)).resolves.toMatchObject({ status: 200 });
      expect(pollWaiterSettled).toBe(false);
    } finally {
      gatewayStopped.resolve();
      setTimeout(() => slowInbound.end(inboundBody.slice(1)), 50);
      await stopping;
    }
    await poll;
    expect(pollWaiterSettled).toBe(true);
    expect(lab.state.getSnapshot()).toMatchObject({ events: [], messages: [] });
    await expect(fetch(`${lab.baseUrl}/healthz`)).rejects.toThrow();
  });

  it("serves bootstrap state and message state", async () => {
    const tempDir = await makeTempDir("qa-lab-test-");
    const outputPath = path.join(tempDir, "self-check.md");
    const repoRoot = await createQaLabRepoRootFixture();

    const lab = await startLab({
      outputPath,
      repoRoot,
      controlUiUrl:
        "https://gateway.example.test/?token=qa-token&api_key=qa-api-key&id_token=qa-id-token&panel=chat#token=fragment-token",
    });

    const bootstrap = await readBootstrap(lab.baseUrl);
    expect(bootstrap).toMatchObject({
      defaults: { conversationId: "qa-operator", senderId: "qa-operator" },
      controlUiUrl: "https://gateway.example.test/?panel=chat",
      controlUiEmbeddedUrl: "https://gateway.example.test/?panel=chat",
      kickoffTask: expect.stringContaining("Lobster Invaders"),
      runner: { status: "idle", selection: { providerMode: "mock-openai", scenarioIds: null } },
      runnerCatalog: {
        channels: [
          "buzz",
          "discord",
          "matrix",
          "msteams",
          "qa-channel",
          "slack",
          "telegram",
          "whatsapp",
        ],
      },
    });
    expect(bootstrap.scenarios.length).toBeGreaterThanOrEqual(10);
    expect(bootstrap.scenarios.map((scenario) => scenario.id)).toContain("dm-chat-baseline");
    expect(bootstrap.runnerCatalog.profiles.map((profile) => profile.id)).toEqual([
      "smoke-ci",
      "personal-agent",
      "observability",
      "release",
      "all",
    ]);
    expect(await getLabJson(lab.baseUrl, "/api/capture/startup-status")).toMatchObject({
      status: { gateway: { url: "https://gateway.example.test/?panel=chat" } },
    });
    lab.setControlUi({
      controlUiUrl:
        "/control-ui/?token=late-token&api_key=late-api-key&id_token=late-id-token&panel=chat#token=fragment-token",
    });
    const relativeBootstrap = await readBootstrap(lab.baseUrl);
    expect(relativeBootstrap).toMatchObject({
      controlUiUrl: "/control-ui/?panel=chat",
      controlUiEmbeddedUrl: "/control-ui/?panel=chat",
    });

    const messageResponse = await postLabJson(lab.baseUrl, "/api/inbound/message", {
      conversation: { id: "bob", kind: "direct" },
      senderId: "bob",
      senderName: "Bob",
      text: "hello from test",
    });
    expect(messageResponse.status).toBe(200);

    const snapshot = await getLabJson<{ messages: Array<{ direction: string; text: string }> }>(
      lab.baseUrl,
      "/api/state",
    );
    expect(snapshot.messages.map((message) => message.text)).toContain("hello from test");
    expect(snapshot.messages.filter((message) => message.direction === "outbound")).toEqual([]);

    await expectFileMissing(outputPath);
  });

  it("serves evidence artifact HEAD metadata and streams GET bodies", async () => {
    const repoRoot = await createQaLabRepoRootFixture();
    const evidenceDir = path.join(repoRoot, ".artifacts", "qa-e2e", "server");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "artifact.log"), "streamed body\n", "utf8");
    await writeEvidenceFixture(evidenceDir, "qa-lab.server-artifact", ["artifact.log"], "gif-log");
    const lab = await startLab({ repoRoot });
    const evidencePath = ".artifacts/qa-e2e/server/qa-evidence.json";
    const request = async (
      route: string,
      params: Record<string, string>,
      status = 200,
      method = "GET",
    ) => {
      const url = new URL(route, lab.baseUrl);
      url.search = new URLSearchParams(params).toString();
      const response = await fetchWithRetry(url.toString(), { method });
      expect(response.status).toBe(status);
      return response;
    };
    const artifact = (params: Record<string, string>, status = 200, method = "GET") =>
      request("/api/evidence/artifact", { evidencePath, ...params }, status, method);
    const evidenceResponse = await request("/api/evidence", { path: evidencePath });
    expect(evidenceResponse.headers.get("cache-control")).toBe("no-store");
    expect(await evidenceResponse.json()).toMatchObject({
      evidence: {
        counts: { pass: 1 },
        entries: [
          {
            id: "qa-lab.server-artifact",
            artifacts: [{ kind: "gif-log", mediaKind: "text", preview: "streamed body\n" }],
          },
        ],
      },
    });

    // Missing evidence must fail before success headers are written, without resetting the connection.
    const missing = await request(
      "/api/evidence",
      { path: ".artifacts/qa-e2e/server/does-not-exist.json" },
      404,
    );
    expect(await missing.text()).not.toBe("");
    const head = await artifact({ artifactPath: "artifact.log" }, 200, "HEAD");
    expect(head.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const get = await artifact({ artifactPath: "artifact.log" });
    for (const response of [head, get]) {
      expect(response.headers.get("content-length")).toBe("14");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(await head.text()).toBe("");
    expect(await get.text()).toBe("streamed body\n");
    const indexed = await artifact({ entryIndex: "0", artifactIndex: "0" });
    expect(await indexed.text()).toBe("streamed body\n");
    for (const params of [
      { entryIndex: "0x0", artifactIndex: "0" },
      { entryIndex: "0", artifactIndex: "1e0" },
      { entryIndex: "00", artifactIndex: "0" },
      { entryIndex: " 0 ", artifactIndex: "0" },
    ]) {
      await artifact(params, 400);
    }
    await writeFile(path.join(evidenceDir, "undeclared.log"), "hidden\n", "utf8");
    await artifact({ artifactPath: "undeclared.log" }, 403);
    const outsideDir = await makeTempDir("qa-lab-outside-artifact-");
    const outsideArtifact = path.join(outsideDir, "outside.log");
    await writeFile(outsideArtifact, "outside\n", "utf8");
    await artifact({ artifactPath: outsideArtifact }, 404);
  });

  it("preserves UTF-8 at the evidence preview byte boundary", async () => {
    const repoRoot = await createQaLabRepoRootFixture();
    const evidenceDir = path.join(repoRoot, ".artifacts", "qa-e2e", "utf8-preview");
    const previewBytes = 12 * 1024;
    const shortReadBytes = 1024;
    const readBoundaryPrefix = "a".repeat(shortReadBytes - 1);
    const readBoundaryText = `${readBoundaryPrefix}😀tail`;
    const splitPrefix = "a".repeat(previewBytes - 1);
    const completePrefix = "a".repeat(previewBytes - Buffer.byteLength("😀"));
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "short-read.log"), readBoundaryText, "utf8");
    await writeFile(path.join(evidenceDir, "split.log"), `${splitPrefix}😀tail`, "utf8");
    await writeFile(path.join(evidenceDir, "complete.log"), `${completePrefix}😀tail`, "utf8");
    await writeEvidenceFixture(evidenceDir, "qa-lab.utf8-preview-boundary", [
      "short-read.log",
      "split.log",
      "complete.log",
    ]);

    const realOpen = fs.open;
    const readPositions = new Map<string, number[]>();
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await realOpen(filePath, flags, mode);
      const realRead = handle.read.bind(handle);
      const artifactName = path.basename(filePath.toString());
      Object.defineProperty(handle, "read", {
        configurable: true,
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const positions = readPositions.get(artifactName) ?? [];
          positions.push(position);
          readPositions.set(artifactName, positions);
          return await realRead(buffer, offset, Math.min(length, shortReadBytes), position);
        },
      });
      return handle;
    });
    cleanups.push(async () => {
      openSpy.mockRestore();
    });

    const lab = await startLab({ repoRoot });
    const evidenceUrl = new URL("/api/evidence", lab.baseUrl);
    evidenceUrl.searchParams.set("path", ".artifacts/qa-e2e/utf8-preview/qa-evidence.json");

    const response = await fetchWithRetry(evidenceUrl.toString());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      evidence: { entries: Array<{ artifacts: Array<{ path: string; preview: string | null }> }> };
    };
    const artifacts = payload.evidence.entries[0]?.artifacts ?? [];
    const shortRead = artifacts.find((artifact) => artifact.path.endsWith("short-read.log"));
    const split = artifacts.find((artifact) => artifact.path.endsWith("split.log"));
    const complete = artifacts.find((artifact) => artifact.path.endsWith("complete.log"));
    expect(shortRead?.preview).toBe(readBoundaryText);
    expect(split?.preview).toBe(splitPrefix);
    expect(complete?.preview).toBe(`${completePrefix}😀`);
    expect(readPositions.get("short-read.log")?.slice(0, 2)).toEqual([0, shortReadBytes]);
    expect(readPositions.get("short-read.log")?.at(-1)).toBe(Buffer.byteLength(readBoundaryText));
    expect(JSON.stringify(payload)).not.toContain("�");
  });

  it("returns controlled errors for malformed JSON body reads", async () => {
    const lab = await startLab();

    const response = await fetch(`${lab.baseUrl}/api/inbound/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Malformed JSON body",
    });
  });

  it("anchors direct self-check runs under the explicit repo root by default", async () => {
    const repoRoot = await makeTempDir("qa-lab-self-check-root-");

    const lab = await startLab({ repoRoot, selfCheckWaitTimeoutMs: 1 });

    const result = await lab.runSelfCheck();
    expect(path.dirname(result.outputPath)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
    expect(path.basename(result.outputPath)).toMatch(/^self-check-[a-z0-9]+-[a-f0-9]{8}\.md$/u);
    expect(await readFile(result.outputPath, "utf8")).toContain("Synthetic Slack-class roundtrip");
  });

  it("injects the kickoff task on demand and on startup", async () => {
    for (const [sendKickoffOnStart, expected] of [
      [true, "QA mission:"],
      [false, "Lobster Invaders"],
    ] as const) {
      const lab = await startLab({ sendKickoffOnStart });
      if (!sendKickoffOnStart) {
        expect((await fetch(`${lab.baseUrl}/api/kickoff`, { method: "POST" })).status).toBe(200);
      }
      const snapshot = await getLabJson<{ messages: Array<{ text: string }> }>(
        lab.baseUrl,
        "/api/state",
      );
      expect(snapshot.messages.map((message) => message.text).join("\n")).toContain(expected);
    }
  });

  it("proxies control-ui paths through /control-ui", async () => {
    const authorizations: Array<string | undefined> = [];
    await withServer(
      (req, res) => {
        authorizations.push(req.headers.authorization);
        if ((req.url ?? "/") === "/healthz") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: "live" }));
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "x-frame-options": "DENY",
          "content-security-policy": "default-src 'self'; frame-ancestors 'none';",
        });
        res.end("<!doctype html><title>control-ui</title><h1>Control UI</h1>");
      },
      async (baseUrl) => {
        const lab = await startQaLabServer({
          embeddedGateway: "disabled",
          advertiseHost: "127.0.0.1",
          advertisePort: 43124,
          controlUiProxyTarget: `${baseUrl}/`,
          controlUiProxyToken: "proxy-token",
        });

        try {
          const bootstrap = await readBootstrap(lab.listenUrl);
          expect(bootstrap.controlUiUrl).toBe("http://127.0.0.1:43124/control-ui/");
          expect(bootstrap.controlUiEmbeddedUrl).toBe("http://127.0.0.1:43124/control-ui/");

          const healthResponse = await fetchWithRetry(`${lab.listenUrl}/control-ui/healthz`);
          expect(healthResponse.status).toBe(200);
          expect(await healthResponse.json()).toEqual({ ok: true, status: "live" });

          const rootResponse = await fetchWithRetry(`${lab.listenUrl}/control-ui/`);
          expect(rootResponse.status).toBe(200);
          expect(rootResponse.headers.get("x-frame-options")).toBeNull();
          expect(rootResponse.headers.get("content-security-policy")).toContain(
            "frame-ancestors 'self'",
          );
          expect(await rootResponse.text()).toContain("Control UI");
          expect(authorizations).toEqual(["Bearer proxy-token", "Bearer proxy-token"]);
        } finally {
          await lab.stop();
        }
      },
    );
  });

  it("serves the built QA UI bundle when available", async () => {
    const uiDistDir = await makeTempDir("qa-lab-ui-dist-");
    await writeFile(
      path.join(uiDistDir, "index.html"),
      "<!doctype html><html><head><title>QA Lab</title></head><body><div id='app'></div></body></html>",
      "utf8",
    );

    const lab = await startLab({
      host: "127.0.0.1",
      port: 0,
      uiDistDir,
    });
    const rootResponse = await fetchWithRetry(`${lab.baseUrl}/`);
    expect(rootResponse.status).toBe(200);
    const html = await rootResponse.text();
    expect(html).not.toContain("QA Lab UI not built");
    expect(html).toContain("<title>");
  });

  it("uses the explicit repo root for ui assets and runner model discovery", async () => {
    const repoRoot = await createQaLabRepoRootFixture({
      models: [
        {
          key: "anthropic/qa-temp-model",
          name: "QA Temp Model",
        },
      ],
      uiHtml:
        "<!doctype html><html><head><title>Temp QA Lab UI</title></head><body>repo-root-ui</body></html>",
    });

    const lab = await startLab({
      repoRoot,
    });

    const rootResponse = await fetchWithRetry(`${lab.baseUrl}/`);
    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.text()).toContain("repo-root-ui");

    const versionResponse = await fetchWithRetry(`${lab.baseUrl}/api/ui-version`);
    expect(versionResponse.status).toBe(200);
    const versionPayload = (await versionResponse.json()) as { version?: string | null };
    expect(versionPayload.version).toBe(resolveUiAssetVersion(null, repoRoot));
    expect(versionPayload.version).toMatch(/^[0-9a-f]{12}$/);

    const runnerCatalog = await waitForRunnerCatalog(lab.baseUrl);
    expect(runnerCatalog.status).toBe("ready");
    const tempModel = runnerCatalog.real.find((model) => model.key === "anthropic/qa-temp-model");
    expect(tempModel?.name).toBe("QA Temp Model");
  });

  it("does not eagerly load the runner model catalog before bootstrap is requested", async () => {
    const repoRoot = await createQaLabRepoRootFixture();
    const markerPath = path.join(repoRoot, "runner-catalog-hit.txt");

    await writeFile(
      path.join(repoRoot, "dist/index.js"),
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join(" "), "utf8");`,
        "process.stdout.write(JSON.stringify({",
        "  models: [{",
        '    key: "openai/gpt-5.6-luna",',
        '    name: "GPT-5.6 Luna",',
        '    input: "openai/gpt-5.6-luna",',
        "    available: true,",
        "    missing: false,",
        "  }],",
        "}));",
      ].join("\n"),
      "utf8",
    );
    const lab = await startLab({ repoRoot });
    await expectFileMissing(markerPath);

    const bootstrapResponse = await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`);
    expect(bootstrapResponse.status).toBe(200);

    const runnerCatalog = await waitForRunnerCatalog(lab.baseUrl);
    expect(runnerCatalog.status).toBe("ready");
    expect(await readFile(markerPath, "utf8")).toContain("models list --all --json");
  });

  it("aborts an in-flight runner model catalog when the lab stops", async ({ signal }) => {
    const repoRoot = await createQaLabRepoRootFixture();
    const markerPath = path.join(repoRoot, "runner-catalog-started.txt");
    const stoppedPath = path.join(repoRoot, "runner-catalog-stopped.txt");

    await writeFile(path.join(repoRoot, "dist/package.json"), '{"type":"module"}');
    await writeFile(
      path.join(repoRoot, "dist/index.js"),
      [
        'import fs from "node:fs";',
        fixtureReceiptClientSource(receipts.endpoint),
        "process.on('SIGTERM', () => {",
        `  fs.writeFileSync(${JSON.stringify(stoppedPath)}, "terminated", "utf8");`,
        "  process.exit(0);",
        "});",
        `fs.writeFileSync(${JSON.stringify(markerPath)}, process.env.OPENCLAW_CODEX_DISCOVERY_LIVE || "", "utf8");`,
        `sendReceipt(${JSON.stringify(markerPath)}, "started");`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    const lab = await startStoppableLab({ repoRoot });

    const bootstrapResponse = await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`);
    expect(bootstrapResponse.status).toBe(200);
    await withinTest(receipts.waitFor(markerPath, "started"), signal);
    expect(await readFile(markerPath, "utf8")).toBe("0");

    await lab.stop();
    if (process.platform !== "win32") {
      // stop joins the catalog command's close, after its SIGTERM handler writes this marker.
      expect(await readFile(stoppedPath, "utf8")).toBe("terminated");
    }
  });

  it("exposes structured outcomes and can attach control-ui after startup", async () => {
    const lab = await startLab();

    expect(await getLabJson(lab.baseUrl, "/api/outcomes")).toMatchObject({
      run: null,
    });

    lab.setScenarioRun({
      kind: "suite",
      status: "running",
      scenarios: [
        { id: "channel-chat-baseline", name: "Channel baseline conversation", status: "pass" },
        { id: "cron-one-minute-ping", name: "Cron one-minute ping", status: "running" },
      ],
    });
    lab.setControlUi({
      controlUiUrl: "http://127.0.0.1:18789/?password=late-password#token=late-token",
    });

    const bootstrap = await readBootstrap(lab.baseUrl);
    expect(bootstrap.controlUiEmbeddedUrl).toBe("http://127.0.0.1:18789/");

    expect(await getLabJson(lab.baseUrl, "/api/outcomes")).toMatchObject({
      run: {
        status: "running",
        counts: { total: 2, pending: 0, running: 1, passed: 1, failed: 0, skipped: 0 },
        scenarios: [{ id: "channel-chat-baseline" }, { id: "cron-one-minute-ping" }],
      },
    });
  });

  it("serves a new capture request after an earlier acquisition rejects", async () => {
    captureMock.acquire.mockRejectedValueOnce(new Error("capture acquisition failed"));
    const lab = await startStoppableLab({ host: "127.0.0.1", port: 0 });

    const failed = await fetchWithRetry(`${lab.baseUrl}/api/capture/sessions`);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "capture acquisition failed" });
    expect(captureMock.acquire).toHaveBeenCalledTimes(1);

    expect(await getLabJson(lab.baseUrl, "/api/capture/sessions")).toEqual({ sessions: [] });
    expect(captureMock.acquire).toHaveBeenCalledTimes(2);

    await lab.stop();
    expect(captureMock.store.close).toHaveBeenCalledTimes(1);
  });

  it("serves proxy capture sessions, events, and query rows", async () => {
    const store = captureMock.store;
    const sessionId = "qa-capture-session";
    captureMock.seedSession(sessionId);
    const lab = await startStoppableLab();

    await fetchWithRetry(`${lab.baseUrl}/healthz`);
    await fetchWithRetry(`${lab.baseUrl}/api/bootstrap`);
    expect(captureMock.acquire).not.toHaveBeenCalled();

    expect(await getLabJson(lab.baseUrl, "/api/capture/sessions")).toEqual({
      sessions: [{ id: sessionId, eventCount: 3 }],
    });
    expect(store.listSessions).toHaveBeenCalledWith(50);
    expect(
      await getLabJson(lab.baseUrl, `/api/capture/events?sessionId=${sessionId}`),
    ).toMatchObject({
      events: [
        {
          flowId: "flow-1",
          payloadPreview: '{"hello":"world"}',
          provider: "openai",
          api: "responses",
          model: "gpt-5.6-luna",
          captureOrigin: "shared-fetch",
        },
        { flowId: "flow-2" },
        { flowId: "flow-3", provider: "ollama", model: "kimi-k2.5:cloud" },
      ],
    });
    expect(store.getSessionEvents).toHaveBeenCalledWith(sessionId, 200);
    expect(await getLabJson(lab.baseUrl, `/api/capture/coverage?sessionId=${sessionId}`)).toEqual({
      coverage: {
        sessionId,
        totalEvents: 3,
        unlabeledEventCount: 0,
        providers: [
          { value: "openai", count: 2 },
          { value: "ollama", count: 1 },
        ],
        models: [
          { value: "gpt-5.6-luna", count: 2 },
          { value: "kimi-k2.5:cloud", count: 1 },
        ],
        localPeers: [{ value: "127.0.0.1:11434", count: 1 }],
      },
    });
    expect(store.summarizeSessionCoverage).toHaveBeenCalledWith(sessionId);
    expect(
      await getLabJson(
        lab.baseUrl,
        `/api/capture/query?sessionId=${sessionId}&preset=double-sends`,
      ),
    ).toEqual({ rows: [{ host: "api.example.com", duplicateCount: 2 }] });
    expect(store.queryPreset).toHaveBeenCalledWith("double-sends", sessionId);
    expect(captureMock.acquire).toHaveBeenCalledTimes(1);

    await lab.stop();
    expect(captureMock.store.close).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
