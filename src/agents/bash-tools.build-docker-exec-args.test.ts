import { describe, expect, it } from "vitest";
import { buildDockerExecArgs } from "./bash-tools.shared.js";

describe("buildDockerExecArgs", () => {
  it("prepends custom PATH after login shell sourcing to preserve both custom and system tools", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        PATH: "/custom/bin:/usr/local/bin:/usr/bin",
        HOME: "/home/user",
      },
      tty: false,
    });

    const bootstrapArg = args[args.length - 3];
    const commandArg = args[args.length - 1];
    expect(args).toContain("OPENCLAW_PREPEND_PATH=/custom/bin:/usr/local/bin:/usr/bin");
    expect(bootstrapArg).toContain('export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"');
    expect(bootstrapArg).toContain('exec /bin/sh -c "$1"');
    expect(commandArg).toMatch(/'[^']*echo'/);
    expect(commandArg).toContain("'hello'");
  });

  it("does not interpolate PATH into the shell bootstrap script", () => {
    const injectedPath = "$(touch /tmp/openclaw-path-injection)";
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        PATH: injectedPath,
        HOME: "/home/user",
      },
      tty: false,
    });

    const bootstrapArg = args[args.length - 3];
    expect(args).toContain(`OPENCLAW_PREPEND_PATH=${injectedPath}`);
    expect(bootstrapArg).not.toContain(injectedPath);
    expect(bootstrapArg).toContain("OPENCLAW_PREPEND_PATH");
  });

  it("does not add PATH export when PATH is not in env", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        HOME: "/home/user",
      },
      tty: false,
    });

    const bootstrapArg = args[args.length - 3];
    const commandArg = args[args.length - 1];
    expect(bootstrapArg).toBe('exec /bin/sh -c "$1"');
    expect(commandArg).toMatch(/'[^']*echo'/);
    expect(commandArg).toContain("'hello'");
    expect(bootstrapArg).not.toContain("export PATH");
  });

  it("includes workdir flag when specified", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "pwd",
      workdir: "/workspace",
      env: { HOME: "/home/user" },
      tty: false,
    });

    expect(args).toContain("-w");
    expect(args).toContain("/workspace");
  });

  it("uses login shell for consistent environment", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo test",
      env: { HOME: "/home/user" },
      tty: false,
    });

    expect(args).toContain("/bin/sh");
    expect(args).toContain("-lc");
  });

  it("includes tty flag when requested", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "bash",
      env: { HOME: "/home/user" },
      tty: true,
    });

    expect(args).toContain("-t");
  });

  it("quotes variable-expansion payloads as literal arguments", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo $HOME",
      env: { HOME: "/home/user" },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(commandArg).toMatch(/'[^']*echo'/);
    expect(commandArg).toContain("'$HOME'");
    expect(commandArg).not.toContain("echo $HOME");
  });

  it("preserves inline env assignments before the executable", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "FOO=bar echo hi",
      env: { HOME: "/home/user" },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(commandArg).toContain("FOO='bar'");
    expect(commandArg).toMatch(/'[^']*echo'/);
    expect(commandArg).toContain("'hi'");
  });

  it("keeps already-enforced canonical commands unchanged", () => {
    const canonicalCommand = "FOO='bar' '/bin/echo' 'hello'";
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: canonicalCommand,
      env: { HOME: "/home/user" },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(commandArg).toBe(canonicalCommand);
  });

  it("rejects unsupported shell token commands", () => {
    expect(() =>
      buildDockerExecArgs({
        containerName: "test-container",
        command: "$(id)",
        env: { HOME: "/home/user" },
        tty: false,
      }),
    ).toThrow(/Security Violation: unsupported sandbox shell syntax/);
    expect(() =>
      buildDockerExecArgs({
        containerName: "test-container",
        command: "echo $(id)",
        env: { HOME: "/home/user" },
        tty: false,
      }),
    ).toThrow(/Security Violation: unsupported sandbox shell syntax/);
  });
});
