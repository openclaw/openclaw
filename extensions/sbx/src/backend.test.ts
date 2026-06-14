// sbx tests cover backend plugin behavior.
import { describe, expect, it } from "vitest";
import { buildSbxExecArgv } from "./cli.js";
import { resolveSbxPluginConfig } from "./config.js";
import { buildSbxSandboxName } from "./backend.js";

describe("buildSbxSandboxName", () => {
  it("produces a deterministic, sbx-safe name", () => {
    const name = buildSbxSandboxName("Agent/Session 1");
    expect(name).toBe(buildSbxSandboxName("Agent/Session 1"));
    expect(name).toMatch(/^openclaw-[a-z0-9-]+-[0-9a-f]{1,8}$/);
  });

  it("falls back to session for empty scope keys", () => {
    expect(buildSbxSandboxName("   ")).toMatch(/^openclaw-session-/);
  });
});

describe("buildSbxExecArgv", () => {
  const baseConfig = resolveSbxPluginConfig(undefined);

  it("builds a non-pty exec invocation through a login shell", () => {
    const argv = buildSbxExecArgv({
      config: baseConfig,
      sandboxName: "openclaw-test-1",
      command: "echo hi",
      workdir: "/work",
      env: { FOO: "bar" },
      usePty: false,
    });
    expect(argv).toEqual([
      "sbx",
      "exec",
      "-i",
      "-w",
      "/work",
      "-e",
      "FOO=bar",
      "openclaw-test-1",
      "/bin/sh",
      "-lc",
      "echo hi",
    ]);
  });

  it("adds a tty flag and exec user when requested", () => {
    const argv = buildSbxExecArgv({
      config: resolveSbxPluginConfig({ user: "root" }),
      sandboxName: "openclaw-test-1",
      command: "bash",
      env: {},
      usePty: true,
    });
    expect(argv).toContain("-t");
    expect(argv.join(" ")).toContain("-u root");
  });

  it("reattaches a custom PATH after the login shell instead of via -e PATH", () => {
    const argv = buildSbxExecArgv({
      config: baseConfig,
      sandboxName: "openclaw-test-1",
      command: "node --version",
      env: { PATH: "/custom/bin" },
      usePty: false,
    });
    expect(argv).not.toContain("PATH=/custom/bin");
    expect(argv).toContain("OPENCLAW_PREPEND_PATH=/custom/bin");
    const script = argv.at(-1) ?? "";
    expect(script).toContain('export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"');
    expect(script).toContain("node --version");
  });
});
