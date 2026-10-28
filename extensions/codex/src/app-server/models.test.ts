import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { createModelFixture as paginatedModel } from "./model-fixture.test-support.js";
import { createClientHarness } from "./test-support.js";

vi.mock("./auth-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-bridge.js")>()),
  applyCodexAppServerAuthProfile: vi.fn(async () => undefined),
  bridgeCodexAppServerStartOptions: vi.fn(async ({ startOptions }) => startOptions),
  resolveCodexAppServerHomeDir: (agentDir: string) => `${agentDir}/codex-home`,
}));

vi.mock("./computer-use-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./computer-use-artifacts.js")>()),
  reconcileCodexComputerUseStartArtifacts: vi.fn(async () => undefined),
}));

// mock-isolation: Model listing uses a fixed empty auth store without loading operator credentials.
vi.mock("./auth-profile.js", () => ({
  resolveCodexAppServerAuthProfileIdForAgent: vi.fn(
    (params?: { authProfileId?: string }) => params?.authProfileId,
  ),
  resolveCodexAppServerAuthProfileStore: () => ({ version: 1, profiles: {} }),
}));

vi.mock("./auth-cache-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-cache-key.js")>()),
  resolveCodexAppServerFallbackApiKeyCacheKey: vi.fn(() => undefined),
}));

vi.mock("./managed-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-binary.js")>()),
  resolveManagedCodexAppServerStartOptions: vi.fn(async (startOptions) => startOptions),
  resolveManagedCodexNativeCommand: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-registration")>()),
  resolveDefaultAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
}));

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let listAllCodexAppServerModels: typeof import("./models.js").listAllCodexAppServerModels;
let readModelListResult: typeof import("./models.js").readModelListResult;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.test-support.js").resetSharedCodexAppServerClientForTests;

const validModelListEntry = paginatedModel("gpt-test");

function modelHarness() {
  const harness = createClientHarness();
  const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
  return {
    send: harness.send,
    page(id: number | undefined, data: unknown[], nextCursor: string | null) {
      harness.send({ id, result: { data, nextCursor } });
    },
    async request(index = 2) {
      if (index === 2) {
        await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
        const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
        harness.send({
          id: initialize.id,
          result: { userAgent: "openclaw/0.149.0 (macOS; test)" },
        });
      }
      await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(index + 1));
      const request = JSON.parse(harness.writes[index] ?? "{}") as {
        id?: number;
        method?: string;
        params?: { cursor?: string | null };
      };
      expect(request.method).toBe("model/list");
      return request;
    },
    close() {
      harness.client.close();
      startSpy.mockRestore();
    },
  };
}

describe("listCodexAppServerModels", () => {
  beforeAll(async () => {
    ({ listCodexAppServerModels, listAllCodexAppServerModels, readModelListResult } =
      await import("./models.js"));
    ({ resetSharedCodexAppServerClientForTests } = await import("./shared-client.test-support.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each([
    { label: "missing model data", response: {} },
    {
      label: "malformed row after a valid model",
      response: { data: [validModelListEntry, { ...validModelListEntry, id: "   " }] },
    },
  ])("rejects $label through the app-server JSON-RPC boundary", async ({ response }) => {
    const harness = modelHarness();
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    const list = await harness.request();
    harness.send({ id: list.id, result: response });

    await expect(listPromise).rejects.toThrow(/Invalid Codex app-server model\/list response/);
    harness.close();
  });

  it("preserves explicit account access programs without guessing missing metadata", () => {
    const result = readModelListResult({
      data: [
        {
          ...validModelListEntry,
          availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] },
        },
        { ...validModelListEntry, availableAccessPrograms: { cyber: [] } },
        { ...validModelListEntry, availableAccessPrograms: null },
      ],
    });
    expect(result.models.map((model) => Reflect.get(model, "availableAccessPrograms"))).toEqual([
      { cyber: ["standard", "daybreak_blue"] },
      { cyber: [] },
      undefined,
    ]);
  });

  it("defaults omitted model modalities at model admission", () => {
    const result = readModelListResult({ data: [validModelListEntry] });

    expect(result.models[0]?.inputModalities).toEqual(["text", "image"]);
    expect(validModelListEntry).not.toHaveProperty("inputModalities");
  });

  it("lists app-server models through the typed helper", async () => {
    const harness = modelHarness();
    const listPromise = listCodexAppServerModels({ limit: 12, timeoutMs: 1000 });
    const list = await harness.request();

    harness.send({
      id: list.id,
      result: {
        data: [
          {
            ...paginatedModel("gpt-5.4", ["text", "image"]),
            upgradeInfo: { model: "gpt-5.6", retirementAt: 1_800_000_000 },
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "xhigh", description: "deep" },
            ],
            multiAgentVersion: "v2",
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    });

    await expect(listPromise).resolves.toEqual({
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "gpt-5.4",
          description: "GPT-5.4",
          hidden: false,
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: ["low", "xhigh"],
          serviceTiers: [],
          defaultReasoningEffort: "medium",
          multiAgentVersion: "v2",
          isDefault: true,
        },
      ],
    });
    harness.close();
  });

  it("lists all app-server model pages through one client", async () => {
    const harness = modelHarness();
    const listPromise = listAllCodexAppServerModels({ limit: 1, timeoutMs: 1000 });
    const firstList = await harness.request();
    expect(firstList.params?.cursor).toBeNull();

    harness.page(firstList.id, [paginatedModel("gpt-5.4", ["text"])], "page-2");
    const secondList = await harness.request(3);
    expect(secondList.params?.cursor).toBe("page-2");

    harness.page(secondList.id, [paginatedModel("gpt-5.5", ["text", "image"])], null);

    const list = await listPromise;
    expect(list.models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.5"]);
    harness.close();
  });

  it("marks all-model listing truncated after the page cap", async () => {
    const harness = modelHarness();
    const listPromise = listAllCodexAppServerModels({ limit: 1, timeoutMs: 1000, maxPages: 1 });
    const firstList = await harness.request();
    harness.page(firstList.id, [paginatedModel("gpt-5.4", ["text"])], "page-2");

    const list = await listPromise;
    expect(list.models.map((model) => model.id)).toEqual(["gpt-5.4"]);
    expect(list.nextCursor).toBe("page-2");
    expect(list.truncated).toBe(true);
    harness.close();
  });
});
