// Memory CLI tests for the case where another plugin owns the memory slot.
import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  firstWrittenJsonArg,
  spyRuntimeErrors,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const getMemorySearchManager = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn((): OpenClawConfig => ({})));

vi.mock("./memory/index.js", () => ({ getMemorySearchManager }));
const resolveCommandSecretRefsViaGateway = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli")>()),
  resolveCommandSecretRefsViaGateway,
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => getRuntimeConfig(),
}));

let registerMemoryCli: typeof import("./cli.js").registerMemoryCli;
let defaultRuntime: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").defaultRuntime;

beforeAll(async () => {
  ({ registerMemoryCli } = await import("./cli.js"));
  ({ defaultRuntime } = await import("openclaw/plugin-sdk/memory-core-host-runtime-cli"));
});

const knowledgeSlot: OpenClawConfig = { plugins: { slots: { memory: "knowledge" } } };

function registerSelectedProvider() {
  const health = vi.fn(async () => ({ status: "ready" as const, message: "42 records" }));
  const close = vi.fn(async () => {});
  const open = vi.fn(async () => ({
    provider: {
      capabilities: {
        sources: ["memory" as const],
        pagination: false,
        candidates: [],
        projectFilter: false,
      },
      search: async () => ({ hits: [] }),
      get: async () => ({ status: "not_found" as const }),
      health,
      close,
    },
  }));
  const registry = createEmptyPluginRegistry();
  registry.memoryCapabilities.push({
    pluginId: "knowledge",
    capability: { providerRuntime: { open } },
  });
  setActivePluginRegistry(registry);
  return { open, health, close };
}

async function runMemoryCli(args: string[]) {
  const program = new Command().name("test");
  registerMemoryCli(program);
  await program.parseAsync(["memory", ...args], { from: "user" });
}

function output(spy: ReturnType<typeof spyRuntimeLogs>) {
  return spy.mock.calls.map((call) => stripVTControlCharacters(String(call[0]))).join("\n");
}

beforeEach(() => {
  process.exitCode = 0;
  resolveCommandSecretRefsViaGateway.mockReset().mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }));
  getMemorySearchManager.mockReset();
  getRuntimeConfig.mockReset().mockReturnValue(knowledgeSlot);
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("memory cli when another plugin owns the memory slot", () => {
  it("reports the selected provider's health instead of the sidecar index", async () => {
    const { open, health, close } = registerSelectedProvider();
    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--agent", "main"]);
    const text = output(log);
    expect(text).toContain("Provider: knowledge (selected memory slot)");
    expect(text).toContain("Health: ready 42 records");
    expect(text).toContain("Memory Core: consolidation sidecar only");
    expect(text).not.toContain("Memory Search");
    expect(text).not.toContain("Indexed:");
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        purpose: "status",
        context: expect.objectContaining({ authority: { kind: "host", operation: "status" } }),
      }),
    );
    expect(health).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("carries the same provider facts in json status", async () => {
    registerSelectedProvider();
    const json = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["status", "--agent", "main", "--json"]);
    expect(firstWrittenJsonArg(json)).toEqual([
      {
        agentId: "main",
        provider: "knowledge",
        health: { status: "ready", message: "42 records" },
        memoryCore: "consolidation-sidecar",
      },
    ]);
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "resolves the selected provider credential (available=%s)",
    async (available) => {
      const credential = { source: "exec", provider: "fixture", id: "token" };
      getRuntimeConfig.mockReturnValue({
        plugins: {
          slots: { memory: "knowledge" },
          entries: { knowledge: { enabled: true, config: { credential } } },
        },
      });
      // The host resolves manifest targets; this boundary must use its materialized config
      // and refuse provider acquisition when the host reports unresolved credentials.
      resolveCommandSecretRefsViaGateway.mockResolvedValue({
        resolvedConfig: {
          plugins: {
            slots: { memory: "knowledge" },
            entries: {
              knowledge: {
                enabled: true,
                config: { credential: available ? "fixture-resolved-token" : undefined },
              },
            },
          },
        },
        diagnostics: available ? [] : ["knowledge credential is unavailable"],
        hadUnresolvedTargets: !available,
      });
      const { open } = registerSelectedProvider();
      const json = spyRuntimeJson(defaultRuntime);

      await runMemoryCli(["status", "--agent", "main", "--json"]);

      if (available) {
        expect(open).toHaveBeenCalledWith(
          expect.objectContaining({
            cfg: expect.objectContaining({
              plugins: expect.objectContaining({
                entries: {
                  knowledge: { enabled: true, config: { credential: "fixture-resolved-token" } },
                },
              }),
            }),
          }),
        );
      } else {
        expect(open).not.toHaveBeenCalled();
      }
      expect(firstWrittenJsonArg(json)).toEqual([
        expect.objectContaining({
          provider: "knowledge",
          health: expect.objectContaining({ status: available ? "ready" : "unavailable" }),
        }),
      ]);
    },
  );

  it("refuses search instead of answering from the sidecar index", async () => {
    const { open } = registerSelectedProvider();
    const errors = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["search", "lights"]);
    expect(output(errors)).toContain('plugins.slots.memory selects "knowledge"');
    expect(process.exitCode).toBe(1);
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps the index status unchanged when Memory Core owns the slot", async () => {
    getRuntimeConfig.mockReturnValue({});
    const { open } = registerSelectedProvider();
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        status: () => ({
          backend: "builtin",
          files: 2,
          chunks: 3,
          dirty: false,
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
        }),
        close: vi.fn(async () => {}),
      },
    });
    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--agent", "main"]);
    const text = output(log);
    expect(text).toContain("Memory Search (main)");
    expect(text).toContain("Indexed: 2/? files · 3 chunks");
    expect(text).not.toContain("consolidation sidecar");
    expect(open).not.toHaveBeenCalled();
  });
});
