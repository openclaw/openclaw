import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const pruneLegacyStoreKeysMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
      },
    }),
  };
});

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    updateSessionStore: (...args: unknown[]) => updateSessionStoreMock(...args),
  };
});

vi.mock("../gateway/session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/session-utils.js")>();
  return {
    ...actual,
    resolveGatewaySessionStoreTarget: (params: { key: string }) => ({
      agentId: "main",
      storePath: "/tmp/subagent-spawn-model-session.json",
      canonicalKey: params.key,
      storeKeys: [params.key],
    }),
    pruneLegacyStoreKeys: (...args: unknown[]) => pruneLegacyStoreKeysMock(...args),
  };
});

vi.mock("./subagent-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry.js")>();
  return {
    ...actual,
    countActiveRunsForSession: () => 0,
    registerSubagentRun: () => {},
  };
});

vi.mock("./subagent-announce.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-announce.js")>();
  return {
    ...actual,
    buildSubagentSystemPrompt: () => "system-prompt",
  };
});

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => false }),
}));

describe("spawnSubagentDirect runtime model persistence", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
    pruneLegacyStoreKeysMock.mockReset();

    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      if (opts.method === "sessions.patch") {
        return { ok: true };
      }
      if (opts.method === "sessions.delete") {
        return { ok: true };
      }
      if (opts.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      return {};
    });

    updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  it("persists runtime model fields on the child session before starting the run", async () => {
    const operations: string[] = [];
    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      operations.push(`gateway:${opts.method ?? "unknown"}`);
      if (opts.method === "sessions.patch") {
        return { ok: true };
      }
      if (opts.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      if (opts.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        operations.push("store:update");
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        persistedStore = store;
        return store;
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "test",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      modelApplied: true,
    });
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
    const [persistedKey, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(persistedKey).toMatch(/^agent:main:subagent:/);
    expect(persistedEntry).toMatchObject({
      modelProvider: "openai-codex",
      model: "gpt-5.4",
    });
    expect(pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(1);
    expect(operations.indexOf("gateway:sessions.patch")).toBeGreaterThan(-1);
    expect(operations.indexOf("store:update")).toBeGreaterThan(
      operations.indexOf("gateway:sessions.patch"),
    );
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(operations.indexOf("store:update"));
  });
});
