import { Command } from "commander";
import {
  firstWrittenJsonArg,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const getMemorySearchManager = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn());
const resolveCommandSecretRefsViaGateway = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({ resolvedConfig: config, diagnostics: [] })),
);

// mock-isolation: exercise CLI diagnostics without opening a native SQLite memory manager.
vi.mock("./memory/index.js", () => ({ getMemorySearchManager }));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-core")>()),
  getRuntimeConfig,
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli")>()),
  resolveCommandSecretRefsViaGateway,
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

function mockManager() {
  getMemorySearchManager.mockResolvedValueOnce({
    manager: {
      status: () => ({
        backend: "builtin",
        provider: "none",
        requestedProvider: "none",
        model: "none",
        sources: ["memory"],
        files: 0,
        chunks: 0,
        dirty: false,
      }),
      close: vi.fn(async () => {}),
    },
  });
}

async function runStatus(json = false) {
  const program = new Command();
  registerMemoryCli(program);
  await program.parseAsync(json ? ["memory", "status", "--json"] : ["memory", "status"], {
    from: "user",
  });
}

beforeEach(() => {
  getRuntimeConfig.mockReturnValue(cfg);
  getMemorySearchManager.mockReset();
});

afterEach(() => vi.restoreAllMocks());

it("shows the excluded session source in human and JSON status", async () => {
  mockManager();
  const logs = spyRuntimeLogs(defaultRuntime);
  await runStatus();

  const output = logs.mock.calls.map((call) => String(call[0])).join("\n");
  expect(output).toContain("sessions requested but disabled");
  expect(output).toContain("memory.search.experimental.sessionMemory=true");

  mockManager();
  const json = spyRuntimeJson(defaultRuntime);
  await runStatus(true);
  expect(firstWrittenJsonArg(json)).toEqual([
    expect.objectContaining({ excludedConfiguredSources: ["sessions"] }),
  ]);
});
