import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSessionBackfillGatewayMethods } from "./session-backfill-gateway.js";
import { executeSessionBackfillBatch } from "./session-backfill.js";

vi.mock("./session-backfill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-backfill.js")>()),
  executeSessionBackfillBatch: vi.fn(),
}));

type RegisteredMethod = {
  handler: (options: GatewayRequestHandlerOptions) => Promise<void>;
  scope: string | undefined;
};

const executeBatchMock = vi.mocked(executeSessionBackfillBatch);
type Execution = Awaited<ReturnType<typeof executeSessionBackfillBatch>>;

function mockBatch(
  topCandidates: string[] = [],
  result: Partial<Execution["result"]> = {},
  continuation = { advanced: false, hasMore: false },
) {
  executeBatchMock.mockResolvedValueOnce({
    result: {
      agentId: "main",
      workspaceDir: "/tmp/main-workspace",
      applied: false,
      rem: false,
      days: topCandidates.length
        ? [{ day: "2026-07-01", candidateCount: topCandidates.length, topCandidates }]
        : [],
      candidateCount: topCandidates.length,
      stagedEntries: 0,
      writtenDiaryEntries: 0,
      replacedDiaryEntries: 0,
      ...result,
    },
    continuation,
  });
}

function createHarness(config?: Record<string, unknown>) {
  const methods = new Map<string, RegisteredMethod>();
  const runtimeConfig = config ?? {
    agents: { entries: { main: { workspace: "/tmp/main-workspace" } } },
  };
  const api = {
    runtime: {
      config: { current: () => runtimeConfig },
      agent: {
        resolveAgentWorkspaceDir: vi.fn(
          (_config: unknown, agentId: string) => `/tmp/${agentId}-workspace`,
        ),
      },
    },
    registerGatewayMethod(
      method: string,
      handler: RegisteredMethod["handler"],
      options?: { scope?: string },
    ) {
      methods.set(method, { handler, scope: options?.scope });
    },
  } as unknown as OpenClawPluginApi;
  registerSessionBackfillGatewayMethods(api);
  return { api, methods };
}

async function invoke(methods: Map<string, RegisteredMethod>, operation: string, params: unknown) {
  const respond = vi.fn();
  await methods
    .get(`memory.sessionBackfill.${operation}`)!
    .handler({ params, respond } as unknown as GatewayRequestHandlerOptions);
  return respond;
}

function expectInvalid(respond: Awaited<ReturnType<typeof invoke>>, message: string) {
  expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST", message });
}

describe("session backfill gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeBatchMock.mockReset();
  });

  it("keeps legacy preview read-only and all owner operations admin-only", () => {
    const { methods } = createHarness();
    for (const operation of ["preview", "apply", "rollback"]) {
      const method = `memory.sessionBackfill.${operation}`;
      const expectedScope = operation === "preview" ? "operator.read" : "operator.admin";
      expect(methods.get(method)?.scope).toBe(expectedScope);
      expect(methods.get(`${method}.owner`)?.scope).toBe("operator.admin");
    }
  });

  it("validates preview params and returns at most three samples per day", async () => {
    const pluginConfig = { memoryPolicy: { excludeSessions: { channels: ["discord"] } } };
    const { methods } = createHarness({
      plugins: { entries: { "memory-core": { config: pluginConfig } } },
    });
    mockBatch(["one", "two", "three", "four"], {}, { advanced: false, hasMore: true });
    const respond = await invoke(methods, "preview", {
      agentId: "main",
      from: "2026-07-01",
      to: "2026-07-31",
      limitDays: 14,
    });

    expect(executeBatchMock).toHaveBeenCalledWith({
      agentId: "main",
      from: "2026-07-01",
      to: "2026-07-31",
      limitDays: 14,
      workspaceDir: "/tmp/main-workspace",
      pluginConfig,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      days: 1,
      candidates: 4,
      perDay: [{ day: "2026-07-01", candidateCount: 4, sample: ["one", "two", "three"] }],
      staged: 0,
      truncated: true,
    });
  });

  it("rejects invalid ranges and unknown params before executing", async () => {
    const { methods } = createHarness();
    const invalidRange = await invoke(methods, "preview", {
      agentId: "main",
      from: "2026-08-01",
      to: "2026-07-01",
    });
    const unexpected = await invoke(methods, "preview", { agentId: "main", archiveFiles: [] });
    const rollback = await invoke(methods, "rollback", { agentId: "main", from: "2026-07-01" });

    expect(executeBatchMock).not.toHaveBeenCalled();
    expectInvalid(invalidRange, "from must not be after to.");
    expectInvalid(unexpected, "unexpected parameter: archiveFiles");
    expectInvalid(rollback, "unexpected parameter: from");
  });

  it("rejects unknown agents in preview", async () => {
    const { methods } = createHarness();
    const respond = await invoke(methods, "preview", { agentId: "missing" });
    expect(executeBatchMock).not.toHaveBeenCalled();
    expectInvalid(respond, 'Unknown agent id "missing".');
  });

  it("accepts a keyed non-default agent", async () => {
    const { methods } = createHarness({ agents: { entries: { main: {}, tester: {} } } });
    mockBatch([], { agentId: "tester", workspaceDir: "/tmp/tester-workspace" });

    const respond = await invoke(methods, "preview", { agentId: "tester" });

    expect(executeBatchMock).toHaveBeenCalledWith({
      agentId: "tester",
      limitDays: 92,
      workspaceDir: "/tmp/tester-workspace",
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
  });

  it("applies a chunk with cursor progress and rolls back by agent", async () => {
    const pluginConfig = { memoryPolicy: { excludeSessions: { chatTypes: ["group"] } } };
    const { methods } = createHarness({
      plugins: { entries: { "memory-core": { config: pluginConfig } } },
    });
    mockBatch(
      ["one", "two"],
      { applied: true, stagedEntries: 1, writtenDiaryEntries: 1 },
      { advanced: true, hasMore: false },
    );
    mockBatch([], { rollback: { removedDiaryEntries: 3, removedStagedEntries: 2 } });

    const applyRespond = await invoke(methods, "apply", { agentId: "main", limitDays: 14 });
    expect(executeBatchMock).toHaveBeenCalledWith(expect.objectContaining({ pluginConfig }));
    expect(applyRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        days: 1,
        candidates: 2,
        staged: 1,
        cursor: { advanced: true, exhausted: false, hasMore: false },
      }),
    );
    const rollbackRespond = await invoke(methods, "rollback", { agentId: "main" });
    expect(rollbackRespond).toHaveBeenCalledWith(true, {
      removedDiaryEntries: 3,
      removedStagedEntries: 2,
    });
  });

  it.each([
    [{ cliResult: true }, "expectedOwnerId must be a non-empty string"],
    [
      { cliResult: true, expectedOwnerId: "current", operationOwnerId: "previous" },
      "Gateway owner changed during session backfill",
    ],
  ])(
    "refuses unbound or replaced CLI ownership before opening a backfill (%j)",
    async (params, message) => {
      const { methods } = createHarness();
      const respond = await invoke(methods, "apply.owner", params);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining(message),
        }),
      );
      expect(executeBatchMock).not.toHaveBeenCalled();
    },
  );
});
