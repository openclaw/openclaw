import { describe, expect, it } from "vitest";
import { buildSandboxExecArgs } from "./docker-sandboxes.js";

describe("buildSandboxExecArgs", () => {
  it("builds basic exec args for a sandbox", () => {
    const args = buildSandboxExecArgs({
      sandboxName: "openclaw-vm-test",
      command: "echo hello",
      workdir: "/workspace",
      env: { LANG: "C.UTF-8" },
      tty: false,
    });

    expect(args).toEqual([
      "sandbox",
      "exec",
      "-i",
      "-w",
      "/workspace",
      "-e",
      "LANG=C.UTF-8",
      "openclaw-vm-test",
      "sh",
      "-lc",
      "echo hello",
    ]);
  });

  it("includes -t flag when tty is true", () => {
    const args = buildSandboxExecArgs({
      sandboxName: "openclaw-vm-test",
      command: "bash",
      env: {},
      tty: true,
    });

    expect(args[2]).toBe("-t");
    expect(args[3]).toBe("-i");
  });

  it("handles PATH prepending", () => {
    const args = buildSandboxExecArgs({
      sandboxName: "openclaw-vm-test",
      command: "node -e 'console.log(1)'",
      env: { PATH: "/custom/bin:/usr/local/bin" },
      tty: false,
    });

    expect(args).toContain("-e");
    const envIndex = args.indexOf("OPENCLAW_PREPEND_PATH=/custom/bin:/usr/local/bin");
    expect(envIndex).toBeGreaterThan(-1);
    // Verify the command includes PATH export
    const cmdArg = args[args.length - 1];
    expect(cmdArg).toContain("OPENCLAW_PREPEND_PATH");
    expect(cmdArg).toContain("node -e 'console.log(1)'");
  });

  it("passes multiple environment variables", () => {
    const args = buildSandboxExecArgs({
      sandboxName: "my-sandbox",
      command: "env",
      workdir: "/home/user/project",
      env: { FOO: "bar", BAZ: "qux" },
      tty: false,
    });

    const envArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-e" && args[i + 1]) {
        envArgs.push(args[i + 1]);
      }
    }
    expect(envArgs).toContain("FOO=bar");
    expect(envArgs).toContain("BAZ=qux");
  });

  it("omits -w when workdir is not provided", () => {
    const args = buildSandboxExecArgs({
      sandboxName: "test-sandbox",
      command: "whoami",
      env: {},
      tty: false,
    });

    expect(args).not.toContain("-w");
  });
});
