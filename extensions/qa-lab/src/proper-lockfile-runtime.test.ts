import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const fixture = fileURLToPath(
  new URL("../test-fixtures/proper-lockfile-runtime.mjs", import.meta.url),
);

function run(mode: string, signal = "SIGTERM", observer = "") {
  const directory = temporary.make("proper-lockfile-runtime-");
  const result = spawnSync(
    resolveTestNodeExecPath(),
    [fixture, mode, directory, "", signal, observer],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  return { directory, result };
}

describe("Crabline lock dependency", () => {
  it("imports without replacing process or native fs functions", () => {
    const { result } = run("import");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("import passed");
  });

  it("preserves lock and recorder behavior while owning listeners only for held locks", () => {
    const { result } = run("features");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("features passed");
  });

  it.each(["", "v3-v4-veto"])(
    "cleans locks on exit without changing the requested exit code (%s)",
    (observer) => {
      const { directory, result } = run("exit", "SIGTERM", observer);
      expect(result.status, result.stderr).toBe(23);
      expect(existsSync(path.join(directory, "resource.lock"))).toBe(false);
    },
  );

  it.each(["SIGINT", "SIGTERM", "SIGHUP"])("defers to an application %s handler", (signal) => {
    const { result } = run("handled", signal);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("handled passed");
  });

  it.each(["veto-release", "veto-compromise"])(
    "retains locks after a vetoed exit and removes temporary handoff listeners (%s)",
    (mode) => {
      const { result } = run(mode, "SIGTERM", "v3-v4-veto");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(`${mode} passed`);
    },
  );

  describe.runIf(process.platform !== "win32")("POSIX termination", () => {
    it.each(["SIGINT", "SIGTERM", "SIGHUP"])(
      "cleans locks and preserves default %s termination",
      (signal) => {
        const { directory, result } = run("signal", signal);
        expect(result.signal, result.stderr).toBe(signal);
        expect(existsSync(path.join(directory, "resource.lock"))).toBe(false);
      },
    );

    it.each(["v3", "v4", "v4-veto", "v3-v4-veto"])(
      "coexists with the installed signal-exit %s observer",
      (observer) => {
        const { directory, result } = run("signal", "SIGTERM", observer);
        expect(result.signal, result.stderr).toBe("SIGTERM");
        expect(existsSync(path.join(directory, "resource.lock"))).toBe(false);
      },
    );

    it.each(["", "v3-v4-veto"])(
      "lets separately installed lockfile copies clean up and terminate (%s)",
      (observer) => {
        const { directory, result } = run("copies", "SIGTERM", observer);
        expect(result.signal, result.stderr).toBe("SIGTERM");
        expect(existsSync(path.join(directory, "resource.lock"))).toBe(false);
        expect(existsSync(path.join(directory, "second.lock"))).toBe(false);
      },
    );
  });
});
