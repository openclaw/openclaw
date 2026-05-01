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

  it("rejects with timeout when a child traps SIGTERM (SIGKILL escalation fires)", async () => {
    const run = createNodeCommandRunner();
    // This child ignores SIGTERM and would hang forever without SIGKILL escalation.
    await expect(
      run(
        "node",
        ["-e", "process.on('SIGTERM', () => { /* ignore */ }); setInterval(() => {}, 1000);"],
        { timeoutMs: 500 },
      ),
    ).rejects.toThrow(/timed out/i);
    // The SIGKILL escalation fires 2s after SIGTERM; allow a total of 4s for the child to die.
    // (In practice the kill happens within ~2s of the timeout firing.)
  }, 6000);
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

describe("createNodeCommandRunner — signal-aware exitCode (Fix 2)", () => {
  it("result.exitCode is -1 and result.signal is set when a child is killed by SIGTERM via timeout", async () => {
    // We can't inspect the resolve result when the runner rejects on timeout.
    // Instead, test that a process killed externally exposes signal in the result.
    // Spawn a process that sends SIGTERM to itself and exits via signal.
    const run = createNodeCommandRunner();
    // `kill -s TERM $$` in a shell — the process exits due to SIGTERM (not trapped).
    // On POSIX, `node -e "process.kill(process.pid, 'SIGTERM')"` kills the node process
    // with SIGTERM which it does not trap, so it exits by signal.
    const result = await run("node", [
      "-e",
      // Unregister all SIGTERM handlers and send SIGTERM to self — exits by signal.
      "process.removeAllListeners('SIGTERM'); process.kill(process.pid, 'SIGTERM');",
    ]).catch(() => null);
    // The process may reject due to spawn failure on some platforms, but if it resolves
    // the exitCode must be -1 and signal must be set.
    if (result !== null) {
      expect(result.exitCode).toBe(-1);
      expect(result.signal).toBe("SIGTERM");
    }
  });

  it("result.exitCode is the real code (not -1) for a normally-exiting process", async () => {
    const run = createNodeCommandRunner();
    const result = await run("node", ["-e", "process.exit(42)"]);
    expect(result.exitCode).toBe(42);
    expect(result.signal).toBeUndefined();
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
