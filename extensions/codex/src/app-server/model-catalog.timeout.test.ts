import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerModelCatalog } from "./model-catalog.js";
import { listAllCodexAppServerModels } from "./models.js";

const transport = vi.hoisted(() => ({ request: vi.fn(), release: vi.fn() }));
vi.mock("./shared-client.js", () => ({
  getLeasedSharedCodexAppServerClient: async () => ({ request: transport.request }),
  createIsolatedCodexAppServerClient: vi.fn(),
  captureSharedCodexAppServerCatalogLifetime: () => () => true,
  releaseLeasedSharedCodexAppServerClient: transport.release,
  isCodexAppServerStartSelectionChangedError: () => false,
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
}));

const params = {
  config: {},
  agentId: "main",
  agentDir: "/synthetic/agent",
  workspaceDir: "/synthetic/workspace",
};
const pluginConfig = { appServer: { transport: "websocket", url: "ws://localhost:12345" } };
const model = {
  id: "synthetic-model",
  model: "synthetic-model",
  displayName: "Synthetic model",
  description: "Synthetic catalog fixture",
  inputModalities: ["text"],
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "medium",
  supportsPersonality: false,
  additionalSpeedTiers: [],
  isDefault: false,
};

describe("Codex catalog refresh deadline", () => {
  let modelRequestStarted: ReturnType<typeof Promise.withResolvers<void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    modelRequestStarted = Promise.withResolvers<void>();
    transport.release.mockClear();
    transport.request.mockReset().mockImplementation(async (method: string) => {
      if (method === "model/list") {
        modelRequestStarted.resolve();
        // Codex bounds its remote refresh at five seconds before returning its
        // own identity-scoped cached or bundled catalog. Include response transit.
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
    const pending = owner.load(params, pluginConfig);
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await modelRequestStarted.promise;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await settled).toEqual({
      value: [expect.objectContaining({ id: model.id, nativeRuntime: "codex" })],
    });
    expect(owner.read({ ...params, provider: "openai", modelId: model.id }, pluginConfig)).toEqual({
      accountType: "chatgpt",
    });
    expect(transport.request.mock.calls.map(([method]) => method)).toEqual([
      "model/list",
      "account/read",
    ]);
    expect(transport.release).toHaveBeenCalledOnce();
  });

  it("allows the same native fallback for standalone listing", async () => {
    const pending = listAllCodexAppServerModels();
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await modelRequestStarted.promise;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await settled).toMatchObject({ value: { models: [{ id: model.id }] } });
    expect(transport.release).toHaveBeenCalledOnce();
  });

  it("honors an explicit shorter deadline and cannot publish a late result", async () => {
    const owner = createCodexAppServerModelCatalog("codex");
    const configured = { ...pluginConfig, discovery: { timeoutMs: 750 } };
    const pending = owner.load(params, configured);
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await modelRequestStarted.promise;
    await vi.advanceTimersByTimeAsync(750);
    await rejected;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(
      owner.read({ ...params, provider: "openai", modelId: model.id }, configured),
    ).toBeUndefined();
    expect(transport.request.mock.calls.map(([method]) => method)).toEqual(["model/list"]);
    expect(transport.release).toHaveBeenCalledOnce();
  });
});
