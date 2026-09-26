import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { build as esbuild } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import {
  appendQaChildOutputTail,
  createQaChildOutputTail,
  readQaChildOutputTail,
} from "./child-output.js";

const CHILD_TIMEOUT_MS = 3_000;
let fixtureCode: string;

beforeAll(async () => {
  // Compile the real owner and executable CLI fallback before timing native
  // signals; cold TypeScript loading must not consume the child's proof budget.
  const result = await esbuild({
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    tsconfig: path.resolve("tsconfig.json"),
    write: false,
    stdin: {
      resolveDir: path.resolve("."),
      contents: `
        import { writeSync } from "node:fs";
        import { createInterface } from "node:readline";
        import { runInterruptibleServer } from "./extensions/qa-lab/src/cli-server-lifecycle.ts";
        import { installCliSignalExitHandlers } from "./src/cli/signal-exit-barrier.ts";

        const send = (value) => writeSync(1, "qa-child:" + JSON.stringify(value) + "\\n");
        const keepalive = setInterval(() => {}, 1_000);
        const failure = new Error("stop failed");
        let calls = 0;
        let release;
        let fail;
        const held = new Promise((resolve, reject) => { release = resolve; fail = reject; });
        const input = createInterface({ input: process.stdin });
        input.on("line", (line) => {
          if (line === "release") release();
          if (line === "reject") fail(failure);
          if (line === "ping") send({ phase: "pending", calls });
        });
        installCliSignalExitHandlers();
        const action = runInterruptibleServer("QA signal fixture", {
          baseUrl: "http://127.0.0.1:43124",
          async stop() {
            calls += 1;
            send({
              phase: "stopping", calls,
              sigint: process.listenerCount("SIGINT"),
              sigterm: process.listenerCount("SIGTERM"),
            });
            await held;
            send({ phase: "complete", calls });
          },
        });
        send({ phase: "ready", execPath: process.execPath });
        try {
          await action;
        } catch (error) {
          send({ phase: "failed", original: error === failure, calls });
          process.exitCode = 1;
        } finally {
          clearInterval(keepalive);
          input.close();
          process.stdin.destroy();
        }
      `,
    },
  });
  const output = result.outputFiles[0];
  if (!output) {
    throw new Error("missing CLI signal fixture bundle");
  }
  fixtureCode = output.text;
});

function startFixture() {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", fixtureCode], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = createQaChildOutputTail(128 * 1024);
  const stderr = createQaChildOutputTail(128 * 1024);
  child.stdout.on("data", (chunk) => appendQaChildOutputTail(stdout, chunk));
  child.stderr.on("data", (chunk) => appendQaChildOutputTail(stderr, chunk));
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  void closed.catch(() => undefined);
  const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
  return {
    child,
    closed,
    stdout,
    stderr,
    async next(): Promise<unknown> {
      while (true) {
        const line = await lines.next();
        if (line.done) {
          throw new Error(
            `signal child closed before its marker: ${readQaChildOutputTail(stderr)}`,
          );
        }
        if (line.value.startsWith("qa-child:")) {
          return JSON.parse(line.value.slice("qa-child:".length)) as unknown;
        }
      }
    },
    async cleanup() {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
      reader.close();
      child.stdin.destroy();
    },
  };
}

describe("QA server signal owner", () => {
  it.skipIf(process.platform === "win32").each(["release", "reject"] as const)(
    "joins the first interrupt until stop can %s",
    async (outcome) => {
      const fixture = startFixture();
      try {
        expect(await fixture.next()).toEqual({ phase: "ready", execPath: process.execPath });
        expect(fixture.child.kill("SIGINT")).toBe(true);
        expect(await fixture.next()).toEqual({
          phase: "stopping",
          calls: 1,
          sigint: 0,
          sigterm: 0,
        });
        fixture.child.stdin.write("ping\n");
        expect(await fixture.next()).toEqual({ phase: "pending", calls: 1 });
        expect(fixture.child.exitCode).toBeNull();
        fixture.child.stdin.end(`${outcome}\n`);
        expect(await fixture.next()).toEqual(
          outcome === "release"
            ? { phase: "complete", calls: 1 }
            : { phase: "failed", original: true, calls: 1 },
        );
        expect(await fixture.closed).toEqual({
          code: outcome === "release" ? 0 : 1,
          signal: null,
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["SIGINT", "SIGINT"],
    ["SIGINT", "SIGTERM"],
    ["SIGTERM", "SIGINT"],
    ["SIGTERM", "SIGTERM"],
  ] as const)("leaves hung %s shutdown through native %s termination", async (first, second) => {
    const fixture = startFixture();
    try {
      expect(await fixture.next()).toEqual({ phase: "ready", execPath: process.execPath });
      expect(fixture.child.kill(first)).toBe(true);
      expect(await fixture.next()).toEqual({ phase: "stopping", calls: 1, sigint: 0, sigterm: 0 });
      expect(fixture.child.kill(second)).toBe(true);
      expect(await fixture.closed).toEqual({ code: null, signal: second });
      expect(readQaChildOutputTail(fixture.stdout)).not.toContain('"phase":"complete"');
      expect(readQaChildOutputTail(fixture.stdout)).not.toContain('"phase":"failed"');
      expect(readQaChildOutputTail(fixture.stderr)).toContain(
        "cleanup and report completion will be unconfirmed.",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
