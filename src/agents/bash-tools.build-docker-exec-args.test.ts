/**
 * Docker exec argument tests for bash tools.
 * Covers PATH handling, shell wrapping, workdir flags, and tty arguments used
 * by sandboxed exec calls.
 */
import { describe, expect, it } from "vitest";
import { buildDockerExecArgs } from "./bash-tools.shared.js";

describe("buildDockerExecArgs", () => {
  it("prepends custom PATH via stdin to avoid shell injection", () => {
    const result = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        PATH: "/custom/bin:/usr/local/bin:/usr/bin",
        HOME: "/home/user",
      },
      tty: false,
    });

    expect(result.args).toContain("OPENCLAW_PREPEND_PATH=/custom/bin:/usr/local/bin:/usr/bin");
    expect(result.stdin).toContain('export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"');
    expect(result.stdin).toContain("echo hello");
    expect(result.stdin).toBe(
      'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH;\necho hello\n',
    );
  });

  it("does not interpolate PATH into the shell command", () => {
    const injectedPath = "$(touch /tmp/openclaw-path-injection)";
    const result = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        PATH: injectedPath,
        HOME: "/home/user",
      },
      tty: false,
    });

    expect(result.args).toContain(`OPENCLAW_PREPEND_PATH=${injectedPath}`);
    expect(result.stdin).not.toContain(injectedPath);
    expect(result.stdin).toContain("OPENCLAW_PREPEND_PATH");
  });

  it("does not add PATH export when PATH is not in env", () => {
    const result = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        HOME: "/home/user",
      },
      tty: false,
    });

    expect(result.stdin).toBe("echo hello\n");
    expect(result.stdin).not.toContain("export PATH");
  });

  it("includes workdir flag when specified", () => {
    const result = buildDockerExecArgs({
      containerName: "test-container",
      command: "pwd",
      workdir: "/workspace",
      env: { HOME: "/home/user" },
      tty: false,
    });

    expect(result.args).toContain("-w");
    expect(result.args).toContain("/workspace");
  });

  it("uses login shell for consistent environment", () => {
    const result = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo test",
      env: { HOME: "/home/user" },
      tty: false,
    });

    expect(result.args).toContain("/bin/sh");
    expect(result.args).toContain("-l");
    // No -c flag: command is piped via stdin to prevent shell injection.
    expect(result.args).not.toContain("-c");
    expect(result.args).not.toContain("-lc");
  });

  it("includes tty flag when requested", () => {
    const result = buildDockerExecArgs({
      containerName: "test-container",
      command: "bash",
      env: { HOME: "/home/user" },
      tty: true,
    });

    expect(result.args).toContain("-t");
  });

  it("shell metacharacters in command are not interpreted", () => {
    const result = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo safe; rm -rf /",
      env: { HOME: "/home/user" },
      tty: false,
    });

    // The semicolon and rm command are passed literally via stdin,
    // not interpreted by -c shell parsing.
    expect(result.stdin).toBe("echo safe; rm -rf /\n");
    expect(result.args).not.toContain("-c");
  });
});
