import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runQaLabSelfCheck, runQaLabSelfCheckCommand } from "./self-check-runner.js";

const { startQaLabServer } = vi.hoisted(() => ({ startQaLabServer: vi.fn() }));
vi.mock("./lab-server.js", () => ({ startQaLabServer }));

describe("QA Lab self-check callers", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    startQaLabServer.mockReset();
    startQaLabServer.mockResolvedValue({
      runSelfCheck: vi.fn().mockResolvedValue({
        outputPath: "/tmp/report.md",
        report: "",
        checks: [{ name: "QA self-check scenario", status: "pass" }],
        scenarioResult: { name: "QA self-check scenario", status: "pass", steps: [] },
      }),
      stop: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves self-check repo-root-relative paths before starting the lab server", async () => {
    await runQaLabSelfCheckCommand({
      repoRoot: "/tmp/openclaw-repo",
      output: ".artifacts/qa/self-check.md",
    });

    expect(startQaLabServer).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputPath: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/self-check.md"),
    });
  });

  it("fails unsuccessful self-checks after stopping the lab server", async () => {
    const stop = vi.fn();
    startQaLabServer.mockResolvedValueOnce({
      runSelfCheck: vi.fn().mockResolvedValue({
        outputPath: "/tmp/failed-report.md",
        report: "",
        checks: [{ name: "QA self-check scenario", status: "fail" }],
        scenarioResult: { name: "QA self-check scenario", status: "fail", steps: [] },
      }),
      stop,
    });

    await expect(runQaLabSelfCheckCommand({ repoRoot: "/tmp/openclaw-repo" })).rejects.toThrow(
      "QA self-check failed. See /tmp/failed-report.md.",
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(stdoutWrite).toHaveBeenCalledWith("QA self-check report: /tmp/failed-report.md\n");
  });

  it.each(
    (["api", "cli"] as const).flatMap((caller) =>
      [
        { primaryFails: true, cleanupFails: false },
        { primaryFails: false, cleanupFails: true },
        { primaryFails: true, cleanupFails: true },
      ].map(({ primaryFails, cleanupFails }) => ({ caller, primaryFails, cleanupFails })),
    ),
  )(
    "preserves $caller self-check failures (run=$primaryFails, stop=$cleanupFails)",
    async ({ caller, primaryFails, cleanupFails }) => {
      const primary = new Error("self-check publication failed");
      const cleanup = new Error("lab shutdown failed");
      const stop = cleanupFails ? vi.fn().mockRejectedValue(cleanup) : vi.fn();
      startQaLabServer.mockResolvedValueOnce({
        runSelfCheck: primaryFails
          ? vi.fn().mockRejectedValue(primary)
          : vi.fn().mockResolvedValue({
              outputPath: "/tmp/qa-self-check.md",
              report: "",
              checks: [{ name: "roundtrip", status: "pass" }],
              scenarioResult: { name: "roundtrip", status: "pass", steps: [] },
            }),
        stop,
      });
      const run =
        caller === "api"
          ? runQaLabSelfCheck({ repoRoot: "/tmp/openclaw-repo" })
          : runQaLabSelfCheckCommand({ repoRoot: "/tmp/openclaw-repo" });
      const failure = await run.catch((error: unknown) => error);
      if (primaryFails && cleanupFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({ cause: primary, errors: [primary, cleanup] });
      } else {
        expect(failure).toBe(primaryFails ? primary : cleanup);
      }
      expect(stop).toHaveBeenCalledOnce();
    },
  );

  it.each(["primary", "cleanup", "both"])("preserves undefined %s failures", async (stage) => {
    const result = {
      outputPath: "/tmp/qa-self-check.md",
      report: "",
      checks: [{ name: "roundtrip", status: "pass" }],
      scenarioResult: { name: "roundtrip", status: "pass", steps: [] },
    };
    const stop = stage === "primary" ? vi.fn() : vi.fn().mockRejectedValue(undefined);
    startQaLabServer.mockResolvedValueOnce({
      runSelfCheck:
        stage === "cleanup"
          ? vi.fn().mockResolvedValue(result)
          : vi.fn().mockRejectedValue(undefined),
      stop,
    });

    const run = runQaLabSelfCheck();
    if (stage === "both") {
      await expect(run).rejects.toMatchObject({
        cause: undefined,
        errors: [undefined, undefined],
      });
    } else {
      await expect(run).rejects.toBeUndefined();
    }
    expect(stop).toHaveBeenCalledOnce();
  });

  it("preserves the CLI's failed-result diagnostic when shutdown also fails", async () => {
    const cleanup = new Error("lab shutdown failed");
    const stop = vi.fn().mockRejectedValue(cleanup);
    startQaLabServer.mockResolvedValueOnce({
      runSelfCheck: vi.fn().mockResolvedValue({
        outputPath: "/tmp/failed-report.md",
        report: "",
        checks: [{ name: "roundtrip", status: "fail" }],
        scenarioResult: { name: "roundtrip", status: "fail", steps: [] },
      }),
      stop,
    });

    const failure = await runQaLabSelfCheckCommand({
      repoRoot: "/tmp/openclaw-repo",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cause: { message: "QA self-check failed. See /tmp/failed-report.md." },
      errors: [{ message: "QA self-check failed. See /tmp/failed-report.md." }, cleanup],
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(stdoutWrite).toHaveBeenCalledWith("QA self-check report: /tmp/failed-report.md\n");
  });

  it.each(["pass", "fail"] as const)(
    "keeps %s scenario results returnable by the direct API",
    async (status) => {
      const result = {
        outputPath: "/tmp/qa-self-check.md",
        report: "",
        checks: [{ name: "roundtrip", status }],
        scenarioResult: { name: "roundtrip", status, steps: [] },
      };
      const stop = vi.fn();
      startQaLabServer.mockResolvedValueOnce({
        runSelfCheck: vi.fn().mockResolvedValue(result),
        stop,
      });

      await expect(runQaLabSelfCheck()).resolves.toBe(result);
      expect(stop).toHaveBeenCalledOnce();
    },
  );
});
