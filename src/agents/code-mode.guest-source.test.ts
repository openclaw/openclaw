import { afterEach, describe, expect, it } from "vitest";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";

async function execute(args: Record<string, unknown>) {
  const { ctx, tools } = createCodeModeHarness();
  applyCodeModeCatalog({ ...ctx, tools });
  return resultDetails(await tools[0]!.execute("source", args));
}

afterEach(resetCodeModeTestState);

describe("Code Mode source validation", () => {
  it.each([
    { code: " ", command: "return 7;" },
    { code: "return 7;", command: " \n " },
  ])("executes the populated alias: %j", async (args) => {
    expect(await execute(args)).toMatchObject({ status: "completed", value: 7 });
  });

  it.each([
    { args: { code: "return 1;", command: "return 2;" }, error: "code and command must match" },
    { args: { code: "", command: "   " }, error: "code or command must be a non-empty string" },
    { args: { code: "return 1;", language: "typescript" }, error: "JavaScript only" },
    { args: { code: "return 1;", typecheck: false }, error: "JavaScript only" },
  ])("rejects invalid control arguments: $args", async ({ args, error }) => {
    await expect(execute(args)).rejects.toThrow(error);
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    "ls -1",
    "pwd",
    "pwd; // inspect the workspace",
    "#!/bin/sh\npwd",
    "# inspect the workspace\npwd",
    "./gradlew test",
    "ls -1; let ls = 7;",
    "NODE_ENV=test\nnpm test",
    'GREETING="hello world" npm test',
    String.raw`A="\\" ls "file" argument`,
    "if [ -d /workspace ]; then pwd; fi",
    "custom-tool --format=json",
    "ls>output",
    "jq . file.json",
  ])("rejects shell source before dispatch: %s", async (code) => {
    expect(await execute({ code })).toMatchObject({
      status: "failed",
      code: "invalid_input",
      error: expect.stringMatching(/JavaScript, not shell commands/),
    });
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    { code: "true;", value: null },
    { code: "return /foo/.test('foo');", value: true },
    { code: "Infinity -1; return 42;", value: 42 },
    { code: "ls -1; function ls() {}", value: null },
    { code: "pwd; var { pwd } = { pwd: 7 }; return pwd;", value: 7 },
    { code: "test instanceof Function; function test() {}", value: null },
    { code: "return `outer ${`require('node:fs')`}`;", value: "outer require('node:fs')" },
    { code: 'return /import.meta/.test("import.meta");', value: true },
    {
      code: "const api = { import(value) { return value; } }; return api?.import?.(42);",
      value: 42,
    },
  ])("executes harmless shell/module-like JavaScript: $code", async ({ code, value }) => {
    expect(await execute({ code })).toMatchObject({ status: "completed", value });
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    String.raw`return r\u0065quire('node:fs');`,
    "return require?.('node:fs');",
    "return (0, require)('node:fs');",
    "const load = require; return load('node:fs');",
    "return module.require('node:fs');",
    "return process.getBuiltinModule('node:fs');",
    "return `${({ value: import('node:fs') }).value}`;",
  ])("rejects module access before dispatch: %s", async (code) => {
    expect(await execute({ code })).toMatchObject({
      status: "failed",
      code: "invalid_input",
      failurePhase: "input",
      bridgeDispatchStarted: false,
      telemetry: { callCount: 0 },
      error: expect.stringContaining("module access is disabled"),
    });
    expect(testing.activeRuns.size).toBe(0);
  });
});
