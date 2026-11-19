import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const now = () => Number(process.hrtime.bigint() / 1_000n) / 1_000;
export function gatewayProcessDisappeared(error: unknown): boolean {
  return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
export function gatewayAffinityMatches(actual: string, expected: string): boolean {
  const allowed = new Set(expected.split(",").map(Number));
  return actual.split(",").every((part) => {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim());
    if (!match) {
      return false;
    }
    const first = Number(match[1]),
      last = Number(match[2] ?? match[1]);
    return (
      first <= last &&
      last - first < allowed.size &&
      Array.from({ length: last - first + 1 }, (_, index) => first + index).every((cpu) =>
        allowed.has(cpu),
      )
    );
  });
}
type Thread = {
  pid: number;
  tid: number;
  born: string;
  name: string;
  affinity: string;
  firstMs: number;
  lastMs: number;
  cpuTicks: number;
  samples: number;
};
type Snapshot = {
  atMs: number;
  cpuUs: number;
  userUs: number;
  systemUs: number;
  rssBytes: number;
  pids: number[];
  threads: number;
};

export function parseGatewayCounters(text: string): Record<string, number> {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(/\s+/u);
        const parsed = Number(value);
        if (!key || !value || !Number.isSafeInteger(parsed) || parsed < 0) {
          throw new Error("Malformed Gateway cgroup counter");
        }
        return [key, parsed];
      }),
  );
}

function counters(file: string) {
  return parseGatewayCounters(readFileSync(file, "utf8"));
}

export function parseGatewayThreadStat(raw: string) {
  const end = raw.lastIndexOf(")");
  const fields = raw.slice(end + 2).split(" ");
  const born = fields[19];
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  if (end < 0 || !born || !/^\d+$/u.test(born) || !Number.isSafeInteger(cpuTicks) || cpuTicks < 0) {
    throw new Error("Malformed Gateway thread stat");
  }
  return { born, cpuTicks, name: raw.slice(raw.indexOf("(") + 1, end) };
}

/** The caller supplies a delegated parent; this owner creates and removes only its own leaf. */
export function createGatewayLoadResources(parent: string) {
  if (process.platform !== "linux") {
    throw new Error("Control UI resource accounting requires Linux cgroup v2");
  }
  const directory = path.join(parent, `openclaw-bench-${randomUUID()}`);
  mkdirSync(directory);
  const threads = new Map<string, Thread>();
  const errors: string[] = [];
  const samples: Snapshot[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let maxRssBytes = 0;
  let maxThreads = 0;
  const read = (): Snapshot => {
    const atMs = now();
    const cpu = counters(path.join(directory, "cpu.stat"));
    const cpuUs = Number(cpu.usage_usec);
    const userUs = Number(cpu.user_usec);
    const systemUs = Number(cpu.system_usec);
    if (![cpuUs, userUs, systemUs].every(Number.isFinite)) {
      throw new Error("Gateway cgroup CPU counters unavailable");
    }
    const pids = readFileSync(path.join(directory, "cgroup.procs"), "utf8")
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number);
    let rssBytes = 0;
    let threadCount = 0;
    for (const pid of pids) {
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        rssBytes += Number(/^VmRSS:\s+(\d+)/mu.exec(status)?.[1] ?? 0) * 1024;
        for (const entry of readdirSync(`/proc/${pid}/task`)) {
          try {
            const raw = readFileSync(`/proc/${pid}/task/${entry}/stat`, "utf8");
            const { born, cpuTicks, name } = parseGatewayThreadStat(raw);
            const key = `${pid}:${entry}:${born}`;
            const item = threads.get(key) ?? {
              pid,
              tid: Number(entry),
              born,
              name,
              affinity:
                readFileSync(`/proc/${pid}/task/${entry}/status`, "utf8").match(
                  /^Cpus_allowed_list:\s*(.+)$/mu,
                )?.[1] ?? "unavailable",
              firstMs: atMs,
              lastMs: atMs,
              cpuTicks: 0,
              samples: 0,
            };
            item.lastMs = atMs;
            item.cpuTicks = cpuTicks;
            item.samples++;
            threads.set(key, item);
            threadCount++;
          } catch (error) {
            if (!gatewayProcessDisappeared(error)) {
              throw error;
            }
          }
        }
      } catch (error) {
        if (!gatewayProcessDisappeared(error)) {
          throw error;
        }
      }
    }
    maxRssBytes = Math.max(maxRssBytes, rssBytes);
    maxThreads = Math.max(maxThreads, threadCount);
    const snapshot = {
      atMs,
      cpuUs,
      userUs,
      systemUs,
      rssBytes,
      pids,
      threads: threadCount,
    };
    if (started) {
      samples.push(snapshot);
    }
    return snapshot;
  };
  try {
    read();
  } catch (error) {
    rmdirSync(directory);
    throw error;
  }
  return {
    directory,
    read,
    start() {
      started = true;
      timer = setInterval(() => {
        try {
          read();
        } catch (error) {
          if (errors.length < 10) {
            errors.push(String(error));
          }
        }
      }, 50);
    },
    finish(window?: { startMs: number; endMs: number }) {
      clearInterval(timer);
      const loadSamples = window
        ? samples.filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs)
        : [];
      return {
        sampleIntervalMs: 50,
        peakRssBytes: maxRssBytes,
        peakThreads: maxThreads,
        loadPeakRssBytes: loadSamples.length
          ? Math.max(...loadSamples.map((sample) => sample.rssBytes))
          : null,
        loadPeakThreads: loadSamples.length
          ? Math.max(...loadSamples.map((sample) => sample.threads))
          : null,
        samples,
        threads: [...threads.values()],
        errors,
      };
    },
    async close() {
      clearInterval(timer);
      const populated = () => counters(path.join(directory, "cgroup.events")).populated;
      const forced = populated() !== 0;
      if (forced) {
        writeFileSync(path.join(directory, "cgroup.kill"), "1");
      }
      const deadline = now() + 1_000;
      while (populated() !== 0 && now() < deadline) {
        await delay(25);
      }
      if (populated() !== 0) {
        throw new Error(`Gateway cgroup still populated: ${directory}`);
      }
      rmdirSync(directory);
      return { forced };
    },
  };
}
