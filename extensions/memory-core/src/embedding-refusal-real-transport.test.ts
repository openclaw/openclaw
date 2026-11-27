import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { readMemorySearchManagerStatus } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createMemoryForgetFixture } from "./memory-forget.test-helpers.js";
import "./memory/test-runtime-mocks.js";
import { isolateMemoryManagerTestConfig } from "./memory/test-config-helpers.js";
import { resetMemoryCoreDreamingStateForTests } from "./test-helpers.js";
import { createMemorySearchTool, testing } from "./tools.js";

// Loaded after the runtime mocks above take effect.
const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");

type Mode = "serve" | number;

const closeServers: Array<() => Promise<void>> = [];

// A chat endpoint that may or may not serve /v1/embeddings, like a metering proxy.
async function startChatEndpoint(initial: Mode) {
  const statuses: number[] = [];
  let mode = initial;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = (await json(req)) as { input?: unknown };
      const status = mode === "serve" ? 200 : mode;
      statuses.push(status);
      res.writeHead(status, { "content-type": "application/json" });
      if (status !== 200) {
        res.end(JSON.stringify({ error: { message: "no embeddings here" } }));
        return;
      }
      const texts = Array.isArray(body.input) ? body.input : [body.input];
      res.end(
        JSON.stringify({
          object: "list",
          data: texts.map((text, index) => ({
            object: "embedding",
            embedding: [String(text).length, index + 0.5, 3],
            index,
          })),
        }),
      );
    })();
  });
  const port = await listenOnLoopback(server);
  const close = () => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    return promise;
  };
  closeServers.push(close);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    statuses,
    setMode: (next: Mode) => {
      mode = next;
    },
  };
}

vi.setConfig({ testTimeout: 240_000 });

let workspace = "";
let state: Awaited<ReturnType<typeof createMemoryForgetFixture>>;

// memory.search names no provider, so embeddings follow the chat provider's endpoint implicitly.
// With plugins isolated, the generic OpenAI-compatible adapter serves "openai" and needs a model.
function implicitConfig(baseUrl: string, model = "text-embedding-3-small"): OpenClawConfig {
  return isolateMemoryManagerTestConfig({
    models: {
      providers: {
        openai: { baseUrl, apiKey: "fixture-token", api: "openai-completions", models: [] },
      },
    },
    memory: { search: { model, query: { minScore: 0 } } },
    agents: { defaults: { workspace }, entries: { main: {} } },
  } as OpenClawConfig);
}

// One tool call per "process": managers and agent databases close afterwards.
async function searchOnce(cfg: OpenClawConfig, query: string) {
  const tool = createMemorySearchTool({ config: cfg, agentId: "main", oneShotCliRun: true });
  if (!tool) {
    throw new Error("memory_search tool missing");
  }
  try {
    return (await tool.execute(query, { query, corpus: "memory" })).details;
  } finally {
    await closeAllMemorySearchManagers();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  }
}

// What a later `openclaw memory status --deep` (or `--index`, purpose "cli") reports.
async function readRecordedStatus(cfg: OpenClawConfig, purpose: "status" | "cli" = "status") {
  const { manager } = await getMemorySearchManager({ cfg, agentId: "main", purpose });
  try {
    const refusal = (await readMemorySearchManagerStatus(manager!)).custom?.embeddingRefusal;
    const probe = await manager!.probeEmbeddingAvailability();
    return { refusal, probe, vectors: await manager!.probeVectorAvailability() };
  } finally {
    await closeAllMemorySearchManagers();
  }
}

afterAll(() => vi.resetConfig());

beforeEach(async () => {
  state = await createMemoryForgetFixture("openclaw-mem-embedding-refusal-");
  workspace = state.workspaceDir;
  await fs.mkdir(path.join(workspace, "memory"));
  await fs.writeFile(path.join(workspace, "memory", "deadline.md"), "Zebra deadline is Friday.");
  testing.resetMemorySearchToolCooldowns();
});

afterEach(async () => {
  await Promise.all(closeServers.splice(0).map((close) => close()));
  await closeAllMemorySearchManagers();
  resetMemoryCoreDreamingStateForTests();
  await state.cleanup();
});

const hit = { results: [expect.objectContaining({ path: "memory/deadline.md" })] };

it("remembers an endpoint without embeddings and keeps keyword search working", async () => {
  const endpoint = await startChatEndpoint(404);
  const cfg = implicitConfig(endpoint.baseUrl);

  expect(await searchOnce(cfg, "Zebra deadline")).toMatchObject(hit);
  const refusedByFirstProcess = endpoint.statuses.length;
  expect(refusedByFirstProcess).toBeGreaterThan(0);
  for (const query of ["Zebra", "deadline Friday", "Zebra deadline Friday"]) {
    expect(await searchOnce(cfg, query)).toMatchObject(hit);
  }

  expect(endpoint.statuses).toEqual(Array(refusedByFirstProcess).fill(404));
  // Status and its read-only readiness check report the refusal instead of probing again.
  const status = await readRecordedStatus(cfg);
  expect(status.refusal).toContain("refused embeddings for text-embedding-3-small (404)");
  expect(status.probe).toMatchObject({ ok: false, error: status.refusal });
  expect(status.vectors).toBe(false);
  expect(endpoint.statuses).toHaveLength(refusedByFirstProcess);
  // A changed model or endpoint is no longer covered by the old endpoint's refusal.
  const changed = implicitConfig(endpoint.baseUrl, "text-embedding-3-large");
  expect((await readRecordedStatus(changed)).refusal).toBeUndefined();
  const moved = await startChatEndpoint("serve");
  const movedStatus = await readRecordedStatus(implicitConfig(moved.baseUrl));
  expect(movedStatus.refusal).toBeUndefined();
  expect(movedStatus.probe).toMatchObject({ ok: true });
  // `memory status --index` on the restored endpoint re-checks it and clears the record.
  endpoint.setMode("serve");
  expect((await readRecordedStatus(cfg, "cli")).probe).toMatchObject({ ok: true });
  expect((await readRecordedStatus(cfg)).refusal).toBeUndefined();
});

it("keeps semantic search through an implicit endpoint that serves embeddings", async () => {
  const endpoint = await startChatEndpoint("serve");
  const cfg = implicitConfig(endpoint.baseUrl);

  expect(await searchOnce(cfg, "Zebra deadline")).toMatchObject(hit);
  expect(await searchOnce(cfg, "Zebra")).toMatchObject(hit);

  expect(endpoint.statuses.length).toBeGreaterThan(1);
  expect(endpoint.statuses.every((status) => status === 200)).toBe(true);
});

it("does not remember an authorization failure", async () => {
  const endpoint = await startChatEndpoint(401);
  const cfg = implicitConfig(endpoint.baseUrl);

  expect(await searchOnce(cfg, "Zebra deadline")).toMatchObject(hit);

  expect(endpoint.statuses).toContain(401);
  expect((await readRecordedStatus(cfg)).refusal).toBeUndefined();
});
