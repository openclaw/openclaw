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
  (typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
  return true;
}

function runMatrix(...args: string[]) {
  const qa = new Command();
  matrixQaCliRegistration.register(qa);
  return qa.parseAsync(["node", "openclaw", "matrix", ...args]);
}

describe("QA Lab Matrix CLI registration", () => {
  const originalExitCode = process.exitCode;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    runLiveTransportQaSuiteCommand.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(mockProcessWrite);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("delegates command options to the Matrix runtime", async () => {
    await runMatrix("--scenario", "matrix-allowlist-hot-reload");

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

  it("prints a failed run and returns after its artifacts are written", async () => {
    runLiveTransportQaSuiteCommand.mockRejectedValue(
      new Error("Matrix QA failed.\nreport: /tmp/report.md"),
    );

    await runMatrix();

    expect(stderrSpy).toHaveBeenCalledWith("Matrix QA failed.\nreport: /tmp/report.md\n");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("keeps the command pending until the suite owner completes", async () => {
    const entered = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    runLiveTransportQaSuiteCommand.mockImplementation(() => {
      entered.resolve();
      return completed.promise;
    });
    let returned = false;
    const command = runMatrix().then(() => {
      returned = true;
    });
    await entered.promise;
    expect(returned).toBe(false);
    process.exitCode = 1;
    completed.resolve();
    await command;
    expect(returned).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
