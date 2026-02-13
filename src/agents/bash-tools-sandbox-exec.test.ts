import { describe, expect, it } from "vitest";
import { buildDockerSandboxExecArgs } from "./bash-tools.shared.js";

describe("buildDockerSandboxExecArgs", () => {
  it("builds docker sandbox exec args", () => {
    const args = buildDockerSandboxExecArgs({
      sandboxName: "openclaw-vm-session-abc123",
      command: "ls -la",
      workdir: "/home/user/project",
      env: { NODE_ENV: "production" },
      tty: false,
    });

    expect(args[0]).toBe("sandbox");
    expect(args[1]).toBe("exec");
    expect(args).toContain("-i");
    expect(args).toContain("-w");
    expect(args).toContain("/home/user/project");
    expect(args).toContain("-e");
    expect(args).toContain("NODE_ENV=production");
    expect(args).toContain("openclaw-vm-session-abc123");
    expect(args[args.length - 1]).toContain("ls -la");
  });

  it("includes tty flag when requested", () => {
    const args = buildDockerSandboxExecArgs({
      sandboxName: "my-sandbox",
      command: "bash",
      env: {},
      tty: true,
    });

    expect(args[2]).toBe("-t");
    expect(args[3]).toBe("-i");
  });

  it("prepends PATH like the container variant", () => {
    const args = buildDockerSandboxExecArgs({
      sandboxName: "my-sandbox",
      command: "which node",
      env: { PATH: "/usr/local/node/bin" },
      tty: false,
    });

    const envArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-e" && args[i + 1]) {
        envArgs.push(args[i + 1]);
      }
    }
    expect(envArgs).toContain("PATH=/usr/local/node/bin");
    expect(envArgs).toContain("OPENCLAW_PREPEND_PATH=/usr/local/node/bin");

    // Command should export PATH
    const cmd = args[args.length - 1];
    expect(cmd).toContain("OPENCLAW_PREPEND_PATH");
    expect(cmd).toContain("which node");
  });
});
