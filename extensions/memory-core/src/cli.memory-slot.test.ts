import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

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
const providerConfig = (credential: unknown): OpenClawConfig => ({
  plugins: {
    ...knowledgeSlot.plugins,
    entries: { knowledge: { enabled: true, config: { credential } } },
  },
});

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

it.each(["text", "json", "unresolved"] as const)(
  "reports selected-provider status (%s)",
  async (mode) => {
    const available = mode !== "unresolved";
    if (mode !== "text") {
      getRuntimeConfig.mockReturnValue(
        providerConfig({ source: "exec", provider: "fixture", id: "token" }),
      );
      // Unresolved host credentials must prevent provider acquisition.
      resolveCommandSecretRefsViaGateway.mockResolvedValue({
        resolvedConfig: providerConfig(available ? "fixture-resolved-token" : undefined),
        diagnostics: available ? [] : ["knowledge credential is unavailable"],
        hadUnresolvedTargets: !available,
      });
    }
    const { open, health, close } = registerSelectedProvider();
    const outputSpy = spyRuntimeLogs(defaultRuntime);
    const jsonSpy = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["status", "--agent", "main", ...(mode === "text" ? [] : ["--json"])]);
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    if (available) {
      expect(open.mock.calls).toMatchObject([
        [
          {
            agentId: "main",
            purpose: "status",
            context: { authority: { kind: "host", operation: "status" } },
            ...(mode === "json" ? { cfg: providerConfig("fixture-resolved-token") } : {}),
          },
        ],
      ]);
      expect(health).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } else {
      expect(open).not.toHaveBeenCalled();
    }
    if (mode === "text") {
      const text = output(outputSpy);
      expect(text).toContain("Provider: knowledge (selected memory slot)");
      expect(text).toContain("Health: ready 42 records");
      expect(text).toContain("Memory Core: consolidation sidecar only");
      expect(text).not.toContain("Memory Search");
      expect(text).not.toContain("Indexed:");
    } else {
      expect(firstWrittenJsonArg(jsonSpy)).toEqual([
        available
          ? {
              agentId: "main",
              provider: "knowledge",
              health: { status: "ready", message: "42 records" },
              memoryCore: "consolidation-sidecar",
            }
          : expect.objectContaining({
              provider: "knowledge",
              health: expect.objectContaining({ status: "unavailable" }),
            }),
      ]);
    }
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

const diagnosticConfig: OpenClawConfig = {
  agents: { entries: { main: {} } },
  memory: {
    search: {
      provider: "none",
      sources: ["memory", "sessions"],
      rememberAcrossConversations: false,
    },
  },
};

async function runDiagnostic(args: string[], results: MemorySearchResult[] = []) {
  getMemorySearchManager.mockResolvedValueOnce({
    manager: {
      search: async () => results,
      status: () => ({ backend: "builtin", provider: "none", sources: ["memory"] }),
      close: vi.fn(async () => {}),
    },
  });
  await runMemoryCli(args);
}

it("shows the excluded session source in human and JSON status", async () => {
  getRuntimeConfig.mockReturnValue(diagnosticConfig);
  const logs = spyRuntimeLogs(defaultRuntime);
  await runDiagnostic(["status"]);
  expect(output(logs)).toContain("sessions requested but disabled");
  expect(output(logs)).toContain("memory.search.experimental.sessionMemory=true");
  const json = spyRuntimeJson(defaultRuntime);
  await runDiagnostic(["status", "--json"]);
  expect(firstWrittenJsonArg(json)).toEqual([
    expect.objectContaining({ excludedConfiguredSources: ["sessions"] }),
  ]);
});

it("reports recall recording failure without discarding search results", async () => {
  const result = {
    path: "MEMORY.md",
    snippet: "The fixture uses a copper telescope.",
    source: "memory" as const,
    startLine: 1,
    endLine: 1,
    score: 0.91,
  };
  getRuntimeConfig.mockReturnValue({
    ...diagnosticConfig,
    plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
  });
  const promotion = await import("./short-term-promotion-record.js");
  vi.spyOn(promotion, "recordShortTermRecalls").mockRejectedValueOnce(
    new Error("fixture recall persistence failed"),
  );
  const json = spyRuntimeJson(defaultRuntime);
  await runDiagnostic(["search", "telescope", "--json"], [result]);
  expect(firstWrittenJsonArg(json)).toEqual({
    results: [result],
    warning: "Memory recall recording failed: fixture recall persistence failed",
  });
});
