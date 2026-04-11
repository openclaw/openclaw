/**
 * Regression tests for subagent spawn model override persistence.
 *
 * Background: When spawning a subagent with a model override, the spawn path
 * must write to override fields (modelOverride, providerOverride) rather than
 * runtime fields (model, modelProvider). The agent startup path in agent-command.ts
 * reads from override fields to determine the initial model selection.
 *
 * Related issues: #48271, #43768, #57306
 */
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedModelOverride,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const pruneLegacyStoreKeysMock = vi.fn();

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

describe("subagent spawn model override persistence (regression)", () => {
  beforeEach(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      loadConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      updateSessionStoreMock,
      pruneLegacyStoreKeysMock,
      workspaceDir: os.tmpdir(),
    }));
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
    pruneLegacyStoreKeysMock.mockReset();
    setupAcceptedSubagentGatewayMock(callGatewayMock);

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

  it("persists model to override fields so child startup reads correct model", async () => {
    const operations: string[] = [];
    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      operations.push(`gateway:${opts.method ?? "unknown"}`);
      if (opts.method === "sessions.patch") {
        return { ok: true };
      }
      if (opts.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      return {};
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    await spawnSubagentDirect(
      { task: "test", model: "anthropic/claude-opus-4-6" },
      { agentSessionKey: "agent:main:main", agentChannel: "discord" },
    );

    // Verify override fields are set (not runtime fields)
    expectPersistedModelOverride({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "anthropic",
      model: "claude-opus-4-6",
      source: "user",
    });

    // Verify runtime fields are NOT set (they would cause the bug)
    const [, entry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(entry).not.toHaveProperty("model");
    expect(entry).not.toHaveProperty("modelProvider");
  });

  it("persists ollama model override correctly", async () => {
    const operations: string[] = [];
    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      operations.push(`gateway:${opts.method ?? "unknown"}`);
      if (opts.method === "sessions.patch") {
        return { ok: true };
      }
      if (opts.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      return {};
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    // Use the exact model from the original bug report
    await spawnSubagentDirect(
      { task: "test", model: "ollama/gemma4:e4b" },
      { agentSessionKey: "agent:main:main", agentChannel: "discord" },
    );

    // Verify override fields are set correctly for ollama model
    expectPersistedModelOverride({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "ollama",
      model: "gemma4:e4b",
      source: "user",
    });
  });

  it("sets modelOverrideSource to user for spawn-initiated overrides", async () => {
    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      if (opts.method === "sessions.patch") {
        return { ok: true };
      }
      if (opts.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      return {};
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      operations: [],
      onStore: (store) => {
        persistedStore = store;
      },
    });

    await spawnSubagentDirect(
      { task: "test", model: "google/gemini-2.5-flash" },
      { agentSessionKey: "agent:main:main", agentChannel: "discord" },
    );

    const [, entry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(entry).toHaveProperty("modelOverrideSource", "user");
  });
});
