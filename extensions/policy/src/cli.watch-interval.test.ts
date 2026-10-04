import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { clearConfigCache } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerPolicyCli } from "./cli.js";

const mocks = vi.hoisted(() => ({
  delay: vi.fn(async (_milliseconds: number) => {
    throw new Error("stop watch fixture");
  }),
}));

vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));

let workspaceDir: string;
let previousExitCode: typeof process.exitCode;

beforeEach(async () => {
  vi.clearAllMocks();
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-watch-interval-"));
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspaceDir);
  await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{}", "utf-8");
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearConfigCache();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

async function runPolicyWatch(args: readonly string[]): Promise<void> {
  const program = new Command().name("openclaw");
  registerPolicyCli(program);
  await program.parseAsync(["policy", "watch", "--json", ...args], { from: "user" });
}

it.each([
  { value: "250", expected: 250 },
  { value: String(MAX_TIMER_TIMEOUT_MS), expected: MAX_TIMER_TIMEOUT_MS },
  { value: "2147483648", expected: MAX_TIMER_TIMEOUT_MS },
  { value: String(Number.MAX_SAFE_INTEGER), expected: MAX_TIMER_TIMEOUT_MS },
])("keeps watch interval $value within the safe timer range", async ({ value, expected }) => {
  await runPolicyWatch(["--interval-ms", value]);

  expect(mocks.delay).toHaveBeenCalledTimes(1);
  expect(mocks.delay).toHaveBeenCalledWith(expected);
});

it("does not schedule polling for a single watch evaluation", async () => {
  await runPolicyWatch(["--once", "--interval-ms", "2147483648"]);

  expect(mocks.delay).not.toHaveBeenCalled();
});
