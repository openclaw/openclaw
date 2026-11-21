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
    "pwd; // inspect the workspace",
    "# inspect the workspace\n# then report it\npwd",
    "#!/usr/bin/env bash\nset -euo pipefail\npwd",
    "/bin/ls /workspace/",
    "export FOO=bar",
    "NODE_ENV=test\nnpm test",
    "GREETING='hello world' ./gradlew test",
    String.raw`A="\\" B='a b' ls "file" argument`,
    "A=\\😀\r\n  ls -1",
    "/* inspect the workspace */ pwd;",
    "ls -1; let ls = 7;",
    "if [ -d /workspace ]; then pwd; fi",
    'for file in /workspace/*; do echo "$file"; done',
    'for ((i=0; i<3; i++)); do echo "$i"; done',
    "function task { pwd; }",
    "jq . file.json",
    "custom-tool --format=json",
    "ls>>output",
    "./gradlew test",
    "C:\\workspace\\run.cmd /q",
    "~/bin/task",
  ])("rejects the shell command %j", (source) => {
    expect(() => prepareSource(source)).toThrow(
      /code-mode exec runs JavaScript, not shell commands\..*enabled async tool global.*catalog\.search\(query\).*Do not retry/u,
    );
  });

  it.each([
    "",
    "return 7;",
    "Infinity -1; return 42;",
    "value || fallback",
    "/foo/.test('foo')",
    "ls ?.('workspace')",
    "ls + count",
    "ls -1; function/**/ls() {}",
    "pwd; var { nested: { pwd } } = { nested: { pwd: 7 } }; return pwd;",
    "pwd; function/**/\u002a/**/pwd() { yield 7; }",
    "ls > limit; function ls() {} var limit = 1;",
    "// shell documentation: ls /workspace\nreturn 7;",
  ])("preserves JavaScript without misclassifying it as shell %j", (source) => {
    expect(prepareSource(source)).toBe(source);
  });

  it.each(["const value = ;", "export const answer = 7;", "export { answer };"])(
    "rejects invalid guest syntax without misclassifying it as shell %j",
    (source) => {
      expect(() => prepareSource(source)).toThrow("SyntaxError at openclaw-code-mode:user.js:");
    },
  );

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
});
