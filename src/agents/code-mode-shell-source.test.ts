import { describe, expect, it } from "vitest";
import {
  CODE_MODE_SHELL_SOURCE_ERROR,
  isShellLikeCodeModeSource,
} from "./code-mode-shell-source.js";

describe("isShellLikeCodeModeSource", () => {
  it.each([
    "ls",
    "ls -1",
    "ls /var/log",
    "pwd;",
    "pwd; // inspect the workspace",
    "# inspect the workspace\n# then report it\npwd",
    "#!/usr/bin/env bash\nset -euo pipefail\npwd",
    "pwd\nls -la /workspace",
    "pwd;ls -la /workspace",
    "pwd && ls /workspace",
    "pwd||ls /workspace",
    "echo hello",
    "echo listing; ls /workspace/ 2>&1 || echo failed",
    "ls /workspace/ > /tmp/wlist.txt 2>&1; cat /tmp/wlist.txt",
    "/bin/ls /workspace/",
    "/usr/local/bin/python3 script.py",
    "sh -c 'ls /workspace/'",
    "export FOO=bar",
    "env FOO=bar node script.js",
    "NODE_ENV=test npm test",
    "NODE_ENV=test\nnpm test",
    "FOO=bar\r\n  npm test",
    "FOO=bar BAR=baz node --version",
    'GREETING="hello world" npm test',
    "GREETING='hello world' ./gradlew test",
    "EMPTY= npm test",
    String.raw`A="\\" ls "file" argument`,
    String.raw`A="\\" B='a b' ls "file" argument`,
    "A=\\😀\r\n  ls -1",
    "// inspect the workspace\npwd",
    "/* inspect the workspace */ pwd;",
    "// use a clean environment\nNODE_ENV=test npm test",
    'git status; const note = "function git";',
    "ls -1; const metadata = { ls: true };",
    "ls -1; let ls = 7;",
    "pwd; class/**/pwd {}",
    "if [ -d /workspace ]; then pwd; fi",
    "if [[ -d /workspace ]]; then pwd; fi",
    "while test -d /workspace; do pwd; done",
    'for file in /workspace/*; do echo "$file"; done',
    'for ((i=0; i<3; i++)); do echo "$i"; done',
    "function task { pwd; }",
    "jq . file.json",
    "custom-tool --format=json",
    "some_cli /workspace/file",
    "ls>output",
    "ls>>output",
    "ls 2> error",
    "ls < input",
    "./gradlew test",
    ".\\gradlew.bat test",
    "C:\\workspace\\run.cmd /q",
    "../bin/task --verbose",
    "/opt/homebrew/bin/tool --version",
    "~/bin/task",
  ])("rejects the shell command %j", (source) => {
    expect(isShellLikeCodeModeSource(source)).toBe(true);
  });

  it.each([
    "",
    "true;",
    "42;",
    '"ls /workspace";',
    "return 7;",
    "return /foo/.test('foo');",
    "Infinity -1; return 42;",
    "eval; return typeof eval;",
    "if (true) { return -1; }",
    "while (false) { return 7; }",
    "for (let i = 0; i < 3; i++) { if (i === 2) { return i; } }",
    "function task() { return 7; } return task();",
    "const value = ;",
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
    "export const answer = 7;",
    "export abstract class Example {}",
    "export = Example;",
    "export async function read() {}",
    "export { answer };",
    "export * from './types';",
    'const result = await exec({ command: "ls" }); return result;',
    "console.log(await read({ path: '/workspace' }));",
    "// shell documentation: ls /workspace\nreturn 7;",
    "/* typed module */ export interface Result { value: number }",
  ])("does not misclassify source as a shell command %j", (source) => {
    expect(isShellLikeCodeModeSource(source)).toBe(false);
  });

  it.each([
    ["repeated quotes", `A=${'""'.repeat(22)}`],
    ["escaped quotes", `A="${'\\"'.repeat(32_000)}`],
  ])("classifies an unfinished assignment with %s promptly", (_name, source) => {
    // Classification is synchronous; exclude time spent waiting for the shared host CPU.
    const started = process.threadCpuUsage();
    expect(isShellLikeCodeModeSource(source)).toBe(false);
    const cpu = process.threadCpuUsage(started);
    expect((cpu.user + cpu.system) / 1_000).toBeLessThan(1_000);
  });

  it("classifies a long chain of assignments without rescanning each suffix", () => {
    const source = `${"A=x ".repeat(32_000)}ls -1`;
    const started = process.threadCpuUsage();
    expect(isShellLikeCodeModeSource(source)).toBe(true);
    const cpu = process.threadCpuUsage(started);
    expect((cpu.user + cpu.system) / 1_000).toBeLessThan(1_000);
  });

  it("explains how to execute a real catalog tool without retrying shell source", () => {
    expect(CODE_MODE_SHELL_SOURCE_ERROR).toContain("JavaScript");
    expect(CODE_MODE_SHELL_SOURCE_ERROR).toContain("not shell");
    expect(CODE_MODE_SHELL_SOURCE_ERROR).toContain("enabled async tool global");
    expect(CODE_MODE_SHELL_SOURCE_ERROR).toContain("catalog.search(query)");
    expect(CODE_MODE_SHELL_SOURCE_ERROR).toContain("Do not retry");
  });
});
