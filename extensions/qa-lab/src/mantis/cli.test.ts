import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { attachMantisFailureArtifact } from "./run-failure.runtime.js";
import type { MantisBeforeAfterOptions } from "./run.runtime.js";

const { runMantisBeforeAfterCommand } = vi.hoisted(() => ({
  runMantisBeforeAfterCommand: vi.fn<(opts: MantisBeforeAfterOptions) => Promise<void>>(),
}));

vi.mock("./cli.runtime.js", () => ({ runMantisBeforeAfterCommand }));
vi.mock("../live-transports/shared/live-transport-cli.js", () => ({
  createLazyCliRuntimeLoader:
    <T>(load: () => Promise<T>) =>
    async () =>
      await load(),
}));

import { registerMantisCli } from "./cli.js";

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function parseRun() {
  const program = new Command();
  registerMantisCli(program.command("qa"));
  return program.parseAsync([
    "node",
    "openclaw",
    "qa",
    "mantis",
    "run",
    "--transport",
    "discord",
    "--scenario",
    "discord-status-reactions-tool-only",
    "--baseline",
    "origin/main",
    "--candidate",
    "HEAD",
  ]);
}

it("declares the Mantis cleanup grace to a run-node IPC parent", async () => {
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
  const send = vi.fn();
  Object.defineProperty(process, "send", { configurable: true, value: send, writable: true });
  runMantisBeforeAfterCommand.mockResolvedValueOnce();
  try {
    await parseRun();
    expect(send).toHaveBeenCalledWith({ graceMs: 125_000, type: "openclaw:shutdown-grace" });
  } finally {
    if (sendDescriptor) {
      Object.defineProperty(process, "send", sendDescriptor);
    } else {
      delete process.send;
    }
  }
});

async function interruptRun(failure: (signal: AbortSignal) => Error) {
  const listenersBefore = new Map(
    INTERRUPT_SIGNALS.map((name) => [name, new Set(process.listeners(name))]),
  );
  const previousExitCode = process.exitCode;
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const started = Promise.withResolvers<AbortSignal>();
  runMantisBeforeAfterCommand.mockImplementationOnce(async (opts) => {
    const signal = opts.signal;
    if (!signal) {
      throw new Error("expected the Mantis CLI to pass an AbortSignal");
    }
    started.resolve(signal);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw failure(signal);
  });

  process.exitCode = undefined;
  try {
    const command = parseRun();
    const signal = await started.promise;
    const signalHandler = process
      .listeners("SIGINT")
      .find(
        (listener) =>
          ![...(listenersBefore.get("SIGINT") ?? [])].some((previous) => previous === listener),
      );
    expect(signalHandler).toBeDefined();
    signalHandler?.("SIGINT");
    await command;

    expect(signal.aborted).toBe(true);
    expect(process.exitCode).toBe(130);
    for (const name of INTERRUPT_SIGNALS) {
      expect(new Set(process.listeners(name))).toEqual(listenersBefore.get(name));
    }
    return stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
  } finally {
    stderrWrite.mockRestore();
    process.exitCode = previousExitCode;
  }
}

it("waits for interrupted cleanup and reports its failure artifact", async () => {
  let cleanupComplete = false;
  const stderr = await interruptRun((signal) => {
    cleanupComplete = true;
    return attachMantisFailureArtifact(
      new Error("Mantis artifact processing aborted", { cause: signal.reason }),
      "/tmp/mantis/error.txt",
    );
  });
  expect(cleanupComplete).toBe(true);
  expect(stderr).toContain("/tmp/mantis/error.txt");
});

it("reports cleanup failure details while preserving the interrupt exit code", async () => {
  const stderr = await interruptRun(
    (signal) =>
      new AggregateError(
        [
          new Error("baseline qa aborted", { cause: signal.reason }),
          new Error("cleanup failed; Mantis error details: /tmp/mantis/error.txt"),
        ],
        "Mantis lane failed and worktree cleanup failed",
        { cause: signal.reason },
      ),
  );
  expect(stderr).toContain("Mantis SIGINT cleanup failed");
  expect(stderr).toContain("cleanup failed");
  expect(stderr).toContain("/tmp/mantis/error.txt");
});
