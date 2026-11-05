import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerReefCli } from "./cli.js";

const stdout = vi.fn<typeof process.stdout.write>(() => true);
const stderr = vi.fn<typeof process.stderr.write>(() => true);
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  stdout.mockClear();
  stderr.mockClear();
  vi.spyOn(process.stdout, "write").mockImplementation(stdout);
  vi.spyOn(process.stderr, "write").mockImplementation(stderr);
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

function register(args: string[]) {
  const program = new Command().exitOverride();
  registerReefCli({ program });
  return program.parseAsync(["reef", "register", "--email", "invalid", ...args], { from: "user" });
}

it("leaves JSON failures to the root CLI renderer without writing a second document", async () => {
  await expect(register(["--json"])).rejects.toThrow("A valid --email is required.");
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
});

it("keeps human failures on stderr with a nonzero exit code", async () => {
  await register([]);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledExactlyOnceWith("A valid --email is required.\n");
  expect(process.exitCode).toBe(1);
});
