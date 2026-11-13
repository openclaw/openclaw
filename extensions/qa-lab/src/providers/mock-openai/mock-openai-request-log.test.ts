import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { requireFlowScenario } from "../../scenario-catalog.test-utils.js";
import { runLoadedScenarioFlow } from "../../scenario-flow-runner.test-support.js";
import { captureQaMockProviderRequests } from "../../suite-provider-artifacts.js";
import { fetchJson } from "../../suite-runtime-gateway.js";
import { createTempDirHarness } from "../../temp-dir.test-helper.js";
import {
  MOCK_OPENAI_DEBUG_REQUEST_LIMIT,
  type MockOpenAiRequestSnapshotInput,
} from "./mock-openai-contracts.js";
import { createMockOpenAiRequestLog } from "./mock-openai-request-log.js";

const marker = "Repo contract followthrough check";
const tempDirs = createTempDirHarness();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  await tempDirs.cleanup();
});

function snapshot(allInputText: string, plannedToolName?: string): MockOpenAiRequestSnapshotInput {
  const body = { input: allInputText };
  const raw = JSON.stringify(body);
  return {
    raw,
    body,
    prompt: allInputText,
    allInputText,
    toolOutput: "",
    model: "fixture-model",
    providerVariant: "openai",
    imageInputCount: 0,
    requestKind: "agent-initial",
    compactionSummaryFaultMode: "none",
    outcome: "success",
    rawByteLength: Buffer.byteLength(raw),
    ...(plannedToolName ? { plannedToolName } : {}),
  };
}

async function startRequestLogServer() {
  const log = createMockOpenAiRequestLog();
  const server = createServer((req, res) => {
    if (!log.handleGet(new URL(req.url ?? "/", "http://localhost"), res)) {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing request-log server address");
  }
  const stop = () =>
    new Promise<void>((resolve, reject) => {
      log.stop();
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  cleanups.push(stop);
  return { log, baseUrl: `http://127.0.0.1:${address.port}`, stop };
}

function runPlanAssertions(baseUrl: string, after: number) {
  const scenario = requireFlowScenario(
    readQaScenarioById("instruction-followthrough-repo-contract"),
  );
  const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
  const planIndex = actions.findIndex(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "set" in action &&
      action.set === "followthroughDebugRequests",
  );
  expect(planIndex).toBeGreaterThanOrEqual(0);
  return runLoadedScenarioFlow(scenario.id, {
    flow: {
      steps: [
        {
          name: "checks recorded request plans",
          actions: [{ set: "requestCursorBefore", value: after }, ...actions.slice(planIndex)],
        },
      ],
    },
    api: { env: { providerMode: "mock-openai", mock: { baseUrl } }, fetchJson },
  });
}

it("filters oversized unrelated snapshots before the bounded consumer and retains full artifacts", async () => {
  const provider = await startRequestLogServer();
  const retained = [provider.log.record(snapshot(marker, "write"))];
  const large = snapshot("unrelated " + "x".repeat(5 * 1024 * 1024));
  retained.push(provider.log.record(large));
  retained.push(provider.log.record(snapshot(marker.toUpperCase(), "read")));
  retained.push(provider.log.record({ ...snapshot("unrelated", "write"), prompt: marker }));
  for (const name of ["read", "read", "write", undefined]) {
    retained.push(provider.log.record(snapshot(marker, name)));
  }

  await expect(fetchJson(`${provider.baseUrl}/debug/requests?after=1`)).rejects.toThrow(
    /JSON response exceeds 16777216 bytes/,
  );
  await expect(
    fetchJson(
      `${provider.baseUrl}/debug/request-plans?after=1&inputContains=repo%20contract%20followthrough%20check`,
    ),
  ).resolves.toEqual([
    { cursor: 3, plannedToolName: "read" },
    { cursor: 5, plannedToolName: "read" },
    { cursor: 6, plannedToolName: "read" },
    { cursor: 7, plannedToolName: "write" },
    { cursor: 8, plannedToolName: null },
  ]);
  await expect(runPlanAssertions(provider.baseUrl, 1)).resolves.toMatchObject({ status: "pass" });

  const outputDir = await tempDirs.makeTempDir("qa-request-log-");
  await captureQaMockProviderRequests({ outputDir, providerMode: "mock-openai", provider });
  const artifact = await fs.readFile(
    path.join(outputDir, "artifacts", "mock-openai-requests.json"),
    "utf8",
  );
  expect(Buffer.byteLength(artifact)).toBeGreaterThan(16 * 1024 * 1024);
  expect(JSON.parse(artifact)).toEqual(retained);
  const after = await fetch(`${provider.baseUrl}/debug/requests?after=7`);
  expect(await after.json()).toEqual([retained[7]]);
});

it.each([
  { plans: [undefined], failure: /plannedToolNames=\[null\]/ },
  { plans: ["write", "read", "read", "read"], failure: /all 3 reads before any write/ },
])("does not mask invalid recorded plan order: $plans", async ({ plans, failure }) => {
  const provider = await startRequestLogServer();
  for (const name of plans) {
    provider.log.record(snapshot(marker, name));
  }
  await expect(runPlanAssertions(provider.baseUrl, 0)).rejects.toThrow(failure);
});

it("preserves cursor errors for full requests and compact plans", async () => {
  const provider = await startRequestLogServer();
  for (let index = 0; index <= MOCK_OPENAI_DEBUG_REQUEST_LIMIT; index++) {
    provider.log.record(snapshot("unrelated"));
  }
  for (const endpoint of ["requests", "request-plans"]) {
    for (const [after, status, error] of [
      ["1.5", 400, "after must be a non-negative safe integer"],
      ["0", 409, "request cursor expired"],
      [
        String(MOCK_OPENAI_DEBUG_REQUEST_LIMIT + 2),
        409,
        "request cursor is ahead of the latest recorded request",
      ],
    ] as const) {
      const response = await fetch(
        `${provider.baseUrl}/debug/${endpoint}?after=${after}&inputContains=absent`,
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
    }
  }
  const invalid = await fetch(`${provider.baseUrl}/debug/request-plans?after=1`);
  expect(invalid.status).toBe(400);
  await expect(invalid.json()).resolves.toEqual({ error: "inputContains must be non-empty" });
});
