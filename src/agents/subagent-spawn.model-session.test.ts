import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionEntryCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const upsertSessionEntryMock = vi.fn();

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

describe("spawnSubagentDirect runtime model persistence", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      upsertSessionEntryMock,
      workspaceDir: os.tmpdir(),
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    upsertSessionEntryMock.mockReset();
    setupAcceptedSubagentGatewayMock(callGatewayMock);

    upsertSessionEntryMock.mockImplementation(() => undefined);
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
    installSessionEntryCaptureMock(upsertSessionEntryMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "test",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      modelApplied: true,
    });
    expect(upsertSessionEntryMock).toHaveBeenCalledTimes(3);
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "openai-codex",
      model: "gpt-5.4",
      overrideSource: "user",
    });
    expect(operations.indexOf("store:upsert")).toBeGreaterThan(-1);
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(
      operations.lastIndexOf("store:upsert"),
    );
  });
});
