import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

// Python's macOS monotonic clock is system-wide; Node's performance clock starts
// at each process. Re-sample the original job clock instead of resetting it.
export class NativeCiBudget {
  readonly workEnd: number;
  readonly cleanupEnd: number;
  readonly started: string;

  constructor(started: string) {
    this.started = started;
    if (!Number.isFinite(Number(started)) || Number(started) <= 0) {
      throw new Error("Missing native job monotonic start");
    }
    const before = performance.now();
    const sample = JSON.parse(
      execFileSync(
        "python3",
        [
          "-I",
          "-S",
          "-c",
          [
            "import json,sys,time",
            "assert sys.version_info >= (3,10), 'Python 3.10+ monotonic clock required'",
            "started=float(sys.argv[1]); now=time.monotonic()",
            "assert 0 < started <= now, 'Invalid native job clock'",
            "print(json.dumps([started+27*60-now,started+30*60-now]))",
          ].join("\n"),
          started,
        ],
        { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 },
      ),
    );
    if (
      !Array.isArray(sample) ||
      sample.length !== 2 ||
      sample.some((x) => typeof x !== "number" || !Number.isFinite(x)) ||
      sample[0] <= 0 ||
      Math.abs(sample[1] - sample[0] - 180) > 1e-9
    ) {
      throw new Error("Invalid or exhausted native job clock");
    }
    this.workEnd = before + sample[0] * 1000;
    this.cleanupEnd = before + sample[1] * 1000;
  }

  timeout(ceiling: number, cleanup = false): number {
    const remaining = (cleanup ? this.cleanupEnd : this.workEnd) - performance.now();
    if (remaining < 1) {
      throw new Error(`Native ${cleanup ? "cleanup" : "work"} budget exhausted`);
    }
    return Math.floor(Math.min(ceiling, remaining));
  }
}
