import { describe, expect, it, vi } from "vitest";
import { prepareSource } from "./code-mode-source.js";

vi.mock("node:vm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:vm")>();
  return {
    ...actual,
    Script: function Script() {
      throw new EvalError("Host string compilation is disabled");
    },
  };
});

describe("Code Mode source preparation", () => {
  it.each([
    "ls",
    "ls -1",
    "pwd;",
    "pwd; // inspect the workspace",
    "# inspect the workspace\n# then report it\npwd",
    "#!/usr/bin/env bash\nset -euo pipefail\npwd",
    "pwd && ls /workspace",
    "pwd||ls /workspace",
    "/bin/ls /workspace/",
    "/usr/local/bin/python3 script.py",
    "export FOO=bar",
    "env FOO=bar node script.js",
    "NODE_ENV=test npm test",
    "NODE_ENV=test\nnpm test",
    "FOO=bar\r\n  npm test",
    'GREETING="hello world" npm test',
    "GREETING='hello world' ./gradlew test",
    "EMPTY= npm test",
    String.raw`A="\\" ls "file" argument`,
    String.raw`A="\\" B='a b' ls "file" argument`,
    "A=\\😀\r\n  ls -1",
    "// inspect the workspace\npwd",
    "/* inspect the workspace */ pwd;",
    'git status; const note = "function git";',
    "ls -1; const metadata = { ls: true };",
    "ls -1; let ls = 7;",
    "pwd; class/**/pwd {}",
    "if [ -d /workspace ]; then pwd; fi",
    'for file in /workspace/*; do echo "$file"; done',
    'for ((i=0; i<3; i++)); do echo "$i"; done',
    "function task { pwd; }",
    "jq . file.json",
    "custom-tool --format=json",
    "ls>output",
    "ls>>output",
    "ls 2> error",
    "ls < input",
    "./gradlew test",
    ".\\gradlew.bat test",
    "C:\\workspace\\run.cmd /q",
    "~/bin/task",
  ])("rejects the shell command %j", (source) => {
    expect(() => prepareSource(source)).toThrow(
      "code-mode exec runs JavaScript, not shell commands.",
    );
  });

  it.each([
    "",
    '"ls /workspace";',
    "return 7;",
    "Infinity -1; return 42;",
    "eval; return typeof eval;",
    "value || fallback",
    "value | mask",
    "value > limit",
    "/foo/.test('foo')",
    "ls('workspace')",
    "ls .call(null)",
    "ls ?.('workspace')",
    "ls = 7",
    "ls + count",
    "ls -1; function ls() {}",
    "ls -1; function/**/ls() {}",
    "echo `hello`; function echo(parts) { return parts[0]; }",
    "pwd\nfunction pwd() {}",
    "pwd; var { pwd } = { pwd: 7 }; return pwd;",
    "pwd; var [pwd] = [7]; return pwd;",
    "pwd; var { nested: { pwd } } = { nested: { pwd: 7 } }; return pwd;",
    "pwd; for (var pwd of [7]) {} return pwd;",
    "pwd; var other = 1, pwd = 7; return pwd;",
    "pwd; function* pwd() { yield 7; }",
    "pwd; function/**/\u002a/**/pwd() { yield 7; }",
    "pwd; var/**/{ pwd } = { pwd: 7 }; return pwd;",
    "node -version; function/**/node() {}; var version = 1;",
    "ls > limit; function ls() {} var limit = 1;",
    "test instanceof Function; function test() {}",
    'const result = await exec({ command: "ls" }); return result;',
    "// shell documentation: ls /workspace\nreturn 7;",
  ])("preserves JavaScript without misclassifying it as shell %j", (source) => {
    expect(prepareSource(source)).toBe(source);
  });

  it.each([
    "const value = ;",
    "export const answer = 7;",
    "export abstract class Example {}",
    "export = Example;",
    "export async function read() {}",
    "export { answer };",
    "export * from './types';",
    "/* typed module */ export interface Result { value: number }",
  ])("rejects invalid guest syntax without misclassifying it as shell %j", (source) => {
    expect(() => prepareSource(source)).toThrow("SyntaxError at openclaw-code-mode:user.js:");
  });

  it.each([
    ["repeated quotes", `A=${'""'.repeat(22)}`, false],
    ["escaped quotes", `A="${'\\"'.repeat(32_000)}`, false],
    ["long assignment chain", `${"A=x ".repeat(32_000)}ls -1`, true],
  ] as const)("rejects %s without pathological rescanning", (_name, source, shell) => {
    // Source preparation is synchronous; exclude time spent waiting for the shared host CPU.
    const started = process.threadCpuUsage();
    expect(() => prepareSource(source)).toThrow(
      shell
        ? "code-mode exec runs JavaScript, not shell commands."
        : "SyntaxError at openclaw-code-mode:user.js:",
    );
    const cpu = process.threadCpuUsage(started);
    expect((cpu.user + cpu.system) / 1_000).toBeLessThan(1_000);
  });

  it("explains how to execute a real catalog tool without retrying shell source", () => {
    expect(() => prepareSource("ls")).toThrow(
      /JavaScript.*not shell.*enabled async tool global.*catalog\.search\(query\).*Do not retry/u,
    );
  });
});
