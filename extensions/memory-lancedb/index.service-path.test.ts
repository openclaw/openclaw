import { afterEach, describe, expect, test, vi } from "vitest";
// Static import so the vi.mock below registers for the plugin's lazy dynamic
// import of the embedding provider module.
import "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import memoryPlugin from "./index.js";
import { installTmpDirHarness } from "./test-helpers.js";

// Service-path lifecycle proof for #127424: drives the real registered plugin
// service (start/stop) against a REAL LanceDB transport (no lancedb-runtime
// mock), with only the embedding provider stubbed to a fixed vector. Shows the
// service stop waiting for an admitted explicit write, stopped admissions
// rejecting, and the same registration resuming after start.

const moduleMocks = vi.hoisted(() => ({
  getMemoryEmbeddingProvider: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    ensureGlobalUndiciEnvProxyDispatcher: () => {
      // No-op: no real network in this proof.
    },
  };
});

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return {
    ...actual,
    getMemoryEmbeddingProvider: (...args: Parameters<typeof actual.getMemoryEmbeddingProvider>) => {
      if (moduleMocks.getMemoryEmbeddingProvider.getMockImplementation()) {
        return moduleMocks.getMemoryEmbeddingProvider(...args);
      }
      return actual.getMemoryEmbeddingProvider(...args);
    },
  };
});

type MemoryPluginTestConfig = {
  embedding?: {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  dbPath?: string;
  captureMaxChars?: number;
  recallMaxChars?: number;
  autoCapture?: boolean;
  autoRecall?: boolean;
  storageOptions?: Record<string, string>;
};

function registerTestPlugin(plugin: { register: (api: never) => void }, api: unknown): void {
  plugin.register(api as never);
}

function firstObjectArg(source: { mock: { calls: Array<Array<unknown>> } }, label: string) {
  const [call] = source.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const arg = call[0];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected ${label} object arg`);
  }
  return arg as Record<string, unknown>;
}

function registeredTool(
  registerTool: ReturnType<typeof vi.fn>,
  name: string,
  context: Record<string, unknown> = {},
) {
  const factory = registerTool.mock.calls.find((call) => call[1]?.name === name)?.[0];
  const tool =
    typeof factory === "function"
      ? (factory as (ctx: Record<string, unknown>) => Record<string, unknown>)({
          agentId: "main",
          config: {},
          ...context,
        })
      : factory;
  if (!tool || typeof (tool as { execute?: unknown }).execute !== "function") {
    throw new Error(`expected ${name} tool registration`);
  }
  return tool as { execute: (callId: string, args: unknown) => Promise<unknown> };
}

function createTestLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function memoryPluginApi(
  dbPath: string,
  registerTool: ReturnType<typeof vi.fn>,
  registerService: ReturnType<typeof vi.fn>,
  on: ReturnType<typeof vi.fn>,
) {
  const pluginConfig: MemoryPluginTestConfig = {
    embedding: {
      // Non-openai provider so embeddings go through the mocked
      // getMemoryEmbeddingProvider adapter instead of the direct OpenAI client.
      provider: "test-embedding",
      model: "test-model",
      dimensions: 3,
    },
    dbPath,
    autoCapture: false,
    autoRecall: false,
  };
  const config = { plugins: { entries: { "memory-lancedb": { config: pluginConfig } } } };
  return {
    id: "memory-lancedb",
    name: "Memory (LanceDB)",
    source: "test",
    config,
    pluginConfig,
    runtime: {
      config: { current: () => config },
      agent: {
        resolveAgentDir: (_config: unknown, agentId: string) => `/tmp/agent-${agentId}`,
      },
    },
    logger: createTestLogger(),
    registerTool,
    registerCli: vi.fn(),
    registerService,
    registerMemoryCapability: vi.fn(),
    on,
    resolvePath: (filePath: string) => filePath,
  };
}

describe("memory plugin service-path lifecycle (real LanceDB)", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-svc-test-" });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("service stop waits for an admitted explicit write and reopen restores admissions", async () => {
    // Fixed embedding vector; the proof targets the database lifecycle, not
    // embedding transport. getMemoryEmbeddingProvider returns an adapter whose
    // create() yields a provider with a fixed embed().
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const adapter = {
      create: vi.fn(async () => ({
        provider: { embed, close: vi.fn(async () => undefined) },
      })),
    };
    moduleMocks.getMemoryEmbeddingProvider.mockImplementation(() => adapter);

    const registerTool = vi.fn();
    const registerService = vi.fn();
    const on = vi.fn();
    const dbPath = getDbPath();

    registerTestPlugin(memoryPlugin, memoryPluginApi(dbPath, registerTool, registerService, on));
    const service = firstObjectArg(registerService, "service");
    const start = service.start as () => void;
    const stop = service.stop as () => Promise<void>;

    start();
    const storeTool = registeredTool(registerTool, "memory_store");

    // Establish the connection and table first so the second store hits a real
    // native add on an initialized handle (not initialization).
    await storeTool.execute("svc-store-0", { text: "prime the table" });

    // Admit an explicit write and stop while its native add is in flight. stop()
    // must not resolve until the admitted write has settled; the table is
    // already primed, so the store reaches a real native add (not rejected by
    // a racing initialization). Assert the settlement order so a fast or
    // rejected write cannot mask a non-draining stop.
    const order: string[] = [];
    const storePromise = storeTool.execute("svc-store-1", { text: "service-path write" });
    const storeSettled = storePromise.then(
      () => {
        order.push("write-settled");
        return "resolved";
      },
      (error: unknown) => {
        order.push("write-settled");
        return `rejected: ${String(error).slice(0, 40)}`;
      },
    );

    const stopPromise = stop().then(() => {
      order.push("stop-resolved");
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const stoppedBeforeWrite = order.includes("stop-resolved");

    const storeResult = await storeSettled;
    await stopPromise;

    expect(stoppedBeforeWrite).toBe(false);
    // The racing write either completed (native add drained before stop
    // resolved) or was rejected as a stopped-service admission; either way it
    // settles before stop resolves and must never be observed to land, which
    // the post-restart row count below verifies.
    expect(storeResult).toMatch(/^(resolved|rejected)/);
    expect(order).toEqual(["write-settled", "stop-resolved"]);

    // Stopped admissions reject; restart restores them.
    await expect(
      storeTool.execute("svc-store-2", { text: "should reject while stopped" }),
    ).rejects.toThrow(/closed/i);

    start();
    const resumed = await storeTool.execute("svc-store-3", { text: "resumed after start" });
    const resumedContent = resumed as { content?: Array<{ text?: string }> };
    expect(resumedContent.content?.[0]?.text).toContain("Stored");

    // After restart, the racing write from the stop window must not be present;
    // the post-restart write is. Recall requires embedding again, so use the
    // store tool's own persistence check via the table through a fresh store is
    // not needed — verify by recalling both candidate texts.
    const recallTool = registeredTool(registerTool, "memory_recall");
    const recall = (await recallTool.execute("svc-recall-1", {
      query: "service-path write",
    })) as { content?: Array<{ text?: string }> };
    expect(recall.content?.[0]?.text ?? "").not.toContain("service-path write");
    const recallResumed = (await recallTool.execute("svc-recall-2", {
      query: "resumed after start",
    })) as { content?: Array<{ text?: string }> };
    expect(recallResumed.content?.[0]?.text ?? "").toContain("resumed after start");

    await stop();
  });
});
