import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerModelCatalog } from "./model-catalog.js";
import { createModelFixture } from "./model-fixture.test-support.js";
import { listAllCodexAppServerModels } from "./models.js";

const transport = vi.hoisted(() => ({ request: vi.fn(), release: vi.fn() }));
vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  getLeasedSharedCodexAppServerClient: async () => ({ request: transport.request }),
  createIsolatedCodexAppServerClient: vi.fn(),
  captureSharedCodexAppServerCatalogLifetime: () => () => true,
  releaseLeasedSharedCodexAppServerClient: transport.release,
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
}));

const params = {
  config: {},
  agentId: "main",
  agentDir: "/synthetic/agent",
  workspaceDir: "/synthetic/workspace",
};
const pluginConfig = { appServer: { transport: "websocket", url: "ws://localhost:12345" } };
const model = createModelFixture("synthetic-model", ["text"]);

describe("Codex catalog refresh deadline", () => {
  let modelRequestStarted: ReturnType<typeof Promise.withResolvers<void>>;
  const readParams = { ...params, provider: "openai", modelId: model.id };
  async function advance(ms = 5_100) {
    await modelRequestStarted.promise;
    await vi.advanceTimersByTimeAsync(ms);
  }
  function expectReleasedAfter(...methods: string[]) {
    expect(transport.request.mock.calls.map(([method]) => method)).toEqual(methods);
    expect(transport.release).toHaveBeenCalledOnce();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    modelRequestStarted = Promise.withResolvers<void>();
    transport.release.mockClear();
    transport.request.mockReset().mockImplementation(async (method: string) => {
      if (method === "model/list") {
        modelRequestStarted.resolve();
        // Native refresh fallback takes five seconds, plus response transit.
        await new Promise((resolve) => {
          setTimeout(resolve, 5_100);
        });
        return { data: [model], nextCursor: null };
      }
      if (method === "account/read") {
        return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("allows native refresh fallback before publishing account-scoped readiness", async () => {
    const owner = createCodexAppServerModelCatalog("codex");
    const result = expect(owner.load(params, pluginConfig)).resolves.toEqual({
      entries: [expect.objectContaining({ id: model.id, nativeRuntime: "codex" })],
      outcomes: [{ provider: "openai", status: "ready", modelAccessPrograms: [] }],
    });
    await advance();
    await result;
    expect(owner.read(readParams, pluginConfig)).toEqual({ accountType: "chatgpt" });
    expectReleasedAfter("account/read", "model/list", "account/read");
  });

  it("allows the same native fallback for standalone listing", async () => {
    const result = expect(listAllCodexAppServerModels()).resolves.toMatchObject({
      models: [{ id: model.id }],
    });
    await advance();
    await result;
    expect(transport.release).toHaveBeenCalledOnce();
  });

  it("honors an explicit shorter deadline and cannot publish a late result", async () => {
    const owner = createCodexAppServerModelCatalog("codex");
    const configured = { ...pluginConfig, discovery: { timeoutMs: 750 } };
    const rejected = expect(owner.load(params, configured)).rejects.toThrow(/timed out/);
    await advance(750);
    await rejected;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(owner.read(readParams, configured)).toBeUndefined();
    expectReleasedAfter("account/read", "model/list");
  });
});
