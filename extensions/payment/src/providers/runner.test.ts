import { describe, expect, it } from "vitest";
import { createNodeCommandRunner } from "./runner.js";

// ---------------------------------------------------------------------------
// CommandRunner — basic unit tests (U3: happy path, timeout, stderr capture)
// Full stress-testing of the Stripe Link adapter's usage of this runner is U4.
// ---------------------------------------------------------------------------

describe("createNodeCommandRunner — happy path", () => {
  it("runs a simple echo command and captures stdout", async () => {
    const run = createNodeCommandRunner();
    const result = await run("echo", ["hello world"]);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("captures non-zero exit code without rejecting", async () => {
    const run = createNodeCommandRunner();
    // `false` always exits with code 1 on POSIX
    const result = await run("false", []);
    expect(result.exitCode).toBe(1);
    // stdout and stderr may be empty; the key thing is we resolve, not reject
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
  });
});

describe("createNodeCommandRunner — stderr capture", () => {
  it("captures stderr output separately from stdout", async () => {
    const run = createNodeCommandRunner();
    // node -e can write to both stdout and stderr
    const result = await run("node", [
      "-e",
      "process.stdout.write('out\\n'); process.stderr.write('err\\n');",
    ]);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(0);
  });
});

describe("createNodeCommandRunner — timeout", () => {
  it("rejects with a timeout error when the command exceeds timeoutMs", async () => {
    const run = createNodeCommandRunner();
    await expect(
      run("node", ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/i);
  });
});

describe("createNodeCommandRunner — stdin input", () => {
  it("passes stdin input to the command", async () => {
    const run = createNodeCommandRunner();
    // cat reads from stdin and echoes to stdout
    const result = await run("cat", [], { input: "hello from stdin\n" });
    expect(result.stdout.trim()).toBe("hello from stdin");
    expect(result.exitCode).toBe(0);
  });
});

describe("createNodeCommandRunner — EPIPE / early-exit child", () => {
  it("does not hang or unhandled-error when input is supplied but the child doesn't read stdin", async () => {
    // `node -e "process.exit(0)"` exits immediately without reading stdin.
    // Before the fix, writing to stdin after the child exits would emit an unhandled
    // EPIPE / ERR_STREAM_DESTROYED error event. With the fix, the no-op error listeners
    // on child.stdin/stdout/stderr swallow the error and the promise resolves cleanly.
    const run = createNodeCommandRunner();
    const result = await run("node", ["-e", "process.exit(0)"], {
      input: "some data that will never be read",
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
  });
});
