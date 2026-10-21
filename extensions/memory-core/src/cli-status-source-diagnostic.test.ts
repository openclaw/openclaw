import { Command } from "commander";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  firstWrittenJsonArg,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const getMemorySearchManager = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn());

// mock-isolation: exercise CLI diagnostics without opening a native SQLite memory manager.
vi.mock("./memory/index.js", () => ({ getMemorySearchManager }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => getRuntimeConfig(),
}));

import { defaultRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import { registerMemoryCli } from "./cli.js";

const cfg = {
  agents: { entries: { main: {} } },
  memory: {
    search: {
      provider: "none",
      sources: ["memory", "sessions"],
      rememberAcrossConversations: false,
    },
  },
};

async function run(args: string[], results: MemorySearchResult[] = []) {
  getMemorySearchManager.mockResolvedValueOnce({
    manager: {
      search: async () => results,
      status: () => ({
        backend: "builtin",
        provider: "none",
        sources: ["memory"],
      }),
      close: vi.fn(async () => {}),
    },
  });
  const program = new Command();
  registerMemoryCli(program);
  await program.parseAsync(["memory", ...args], { from: "user" });
}

beforeEach(() => {
  getRuntimeConfig.mockReturnValue(cfg);
  getMemorySearchManager.mockReset();
});

afterEach(() => vi.restoreAllMocks());

it("shows the excluded session source in human and JSON status", async () => {
  const logs = spyRuntimeLogs(defaultRuntime);
  await run(["status"]);

  const output = logs.mock.calls.map((call) => String(call[0])).join("\n");
  expect(output).toContain("sessions requested but disabled");
  expect(output).toContain("memory.search.experimental.sessionMemory=true");

  const json = spyRuntimeJson(defaultRuntime);
  await run(["status", "--json"]);
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
    ...cfg,
    plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
  });
  const promotion = await import("./short-term-promotion-record.js");
  vi.spyOn(promotion, "recordShortTermRecalls").mockRejectedValueOnce(
    new Error("fixture recall persistence failed"),
  );
  const json = spyRuntimeJson(defaultRuntime);
  await run(["search", "telescope", "--json"], [result]);

  expect(firstWrittenJsonArg(json)).toEqual({
    results: [result],
    warning: "Memory recall recording failed: fixture recall persistence failed",
  });
});
