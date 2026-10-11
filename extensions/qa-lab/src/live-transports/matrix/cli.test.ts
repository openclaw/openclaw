// Qa Lab Matrix tests cover the thin CLI selector and adapter registration.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runLiveTransportQaSuiteCommand = vi.hoisted(() => vi.fn());

vi.mock("../shared/live-transport-suite.runtime.js", () => ({ runLiveTransportQaSuiteCommand }));

import { matrixQaCliRegistration } from "./cli.js";

function mockProcessWrite(
  _chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
  callback?: (err?: Error | null) => void,
) {
  if (typeof encodingOrCallback === "function") {
    encodingOrCallback();
  } else {
    callback?.();
  }
  return true;
}

describe("QA Lab Matrix CLI registration", () => {
  const originalExitCode = process.exitCode;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    runLiveTransportQaSuiteCommand.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(mockProcessWrite);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(mockProcessWrite);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("exposes only QA Lab selector flags", () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    const matrix = qa.commands.find((command) => command.name() === "matrix");
    const optionNames = matrix?.options.map((option) => option.long) ?? [];

    for (const optionName of [
      "--repo-root",
      "--output-dir",
      "--provider-mode",
      "--model",
      "--alt-model",
      "--scenario",
      "--fast",
      "--fail-fast",
      "--sut-account",
    ]) {
      expect(optionNames).toContain(optionName);
    }
    for (const optionName of ["--profile", "--shard", "--credential-source", "--credential-role"]) {
      expect(optionNames).not.toContain(optionName);
    }
  });

  it("delegates command options to the Matrix runtime", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);

    await qa.parseAsync([
      "node",
      "openclaw",
      "matrix",
      "--scenario",
      "matrix-allowlist-hot-reload",
    ]);

    expect(runLiveTransportQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "matrix",
        credentialMode: "env-only",
        options: expect.objectContaining({
          providerMode: "live-frontier",
          scenarioIds: ["matrix-allowlist-hot-reload"],
        }),
      }),
    );
  });

  it("returns successfully after Matrix artifacts are written", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    runLiveTransportQaSuiteCommand.mockResolvedValue(undefined);

    await qa.parseAsync(["node", "openclaw", "matrix"]);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a failed run and returns after its artifacts are written", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    runLiveTransportQaSuiteCommand.mockRejectedValue(
      new Error("Matrix QA failed.\nreport: /tmp/report.md"),
    );

    await qa.parseAsync(["node", "openclaw", "matrix"]);

    expect(stderrSpy).toHaveBeenCalledWith("Matrix QA failed.\nreport: /tmp/report.md\n");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("preserves a failed suite exit code after the runtime returns", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    runLiveTransportQaSuiteCommand.mockImplementation(async () => {
      process.exitCode = 1;
    });

    await qa.parseAsync(["node", "openclaw", "matrix"]);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("keeps the command pending until the suite owner completes", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    const entered = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    runLiveTransportQaSuiteCommand.mockImplementation(() => {
      entered.resolve();
      return completed.promise;
    });
    let returned = false;
    const command = qa.parseAsync(["node", "openclaw", "matrix"]).then(() => {
      returned = true;
    });
    await entered.promise;
    expect(returned).toBe(false);
    completed.resolve();
    await command;
    expect(returned).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("prints unexpected errors without forcing process exit", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    runLiveTransportQaSuiteCommand.mockRejectedValue(new Error("scenario failed"));

    await qa.parseAsync(["node", "openclaw", "matrix"]);

    expect(stderrSpy).toHaveBeenCalledWith("scenario failed\n");
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
