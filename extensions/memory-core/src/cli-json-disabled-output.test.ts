/* Start By Cursor Rule, hlo1bfqo7u6z4yv2uxqwfs6xgv5fqg2g */
// Disabled-memory --json contract: stdout stays a parseable document and the
// status aggregate keeps reporting disabled agents instead of dropping them.
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { defaultRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import {
  firstWrittenJsonArg as jsonValue,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerMemoryCli } from "./cli.js";

const getMemorySearchManager = vi.hoisted(() => vi.fn());
const getRuntimeConfig = vi.hoisted(() => vi.fn((): OpenClawConfig => ({})));
const resolveCommandSecretRefsViaGateway = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  })),
);

vi.mock("./memory/index.js", () => ({ getMemorySearchManager }));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli")>()),
  resolveCommandSecretRefsViaGateway,
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => getRuntimeConfig(),
}));

async function run(args: string[]) {
  const program = new Command().name("test");
  registerMemoryCli(program);
  await program.parseAsync(["memory", ...args], { from: "user" });
}

beforeEach(() => {
  process.exitCode = 0;
  getRuntimeConfig.mockReset().mockReturnValue({});
  getMemorySearchManager.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps the disabled-memory notice off --json stdout", async () => {
  getMemorySearchManager.mockResolvedValueOnce({ manager: null });
  const logs = spyRuntimeLogs(defaultRuntime);
  const writeJson = spyRuntimeJson(defaultRuntime);
  await run(["search", "--query", "fixture query", "--json"]);
  expect(jsonValue(writeJson)).toEqual({ agentId: "main", status: "disabled" });
  expect(logs).not.toHaveBeenCalled();
});

it("reports disabled agents in the status --json aggregate", async () => {
  getMemorySearchManager.mockResolvedValueOnce({ manager: null });
  const logs = spyRuntimeLogs(defaultRuntime);
  const writeJson = spyRuntimeJson(defaultRuntime);
  await run(["status", "--json"]);
  expect(jsonValue(writeJson)).toEqual([{ agentId: "main", status: "disabled" }]);
  expect(logs).not.toHaveBeenCalled();
});

it("keeps printing the disabled notice for non-json status", async () => {
  getMemorySearchManager.mockResolvedValueOnce({ manager: null });
  const logs = spyRuntimeLogs(defaultRuntime);
  const writeJson = spyRuntimeJson(defaultRuntime);
  await run(["status"]);
  expect(logs).toHaveBeenCalledWith("Memory search disabled.");
  expect(writeJson).not.toHaveBeenCalled();
});
/* End By Cursor Rule, hlo1bfqo7u6z4yv2uxqwfs6xgv5fqg2g */
