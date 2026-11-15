import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runCrabboxProcess } from "./crabbox-process.js";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandWithTimeout: mocks.run,
}));

it.each([
  { name: "default", binary: process.execPath, cwd: undefined, expected: os.homedir() },
  {
    name: "relative executable",
    binary: path.relative(process.cwd(), process.execPath),
    cwd: undefined,
    expected: os.homedir(),
  },
  { name: "project", binary: process.execPath, cwd: process.cwd(), expected: process.cwd() },
])("runs from the $name directory", async ({ binary, cwd, expected }) => {
  await runCrabboxProcess([binary, "--version"], {
    cwd,
    timeoutMs: 10_000,
  });
  expect(mocks.run).toHaveBeenLastCalledWith([process.execPath, "--version"], {
    cwd: expected,
    timeoutMs: 10_000,
  });
});
