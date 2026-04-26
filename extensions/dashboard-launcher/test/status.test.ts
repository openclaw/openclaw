import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { logPaths } from "../src/paths.js";
import { formatStatus, probeHealth, status } from "../src/status.js";
import { writeIntent, writePid } from "../src/supervisor.js";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "dashboard-launcher-status-"));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("probeHealth", () => {
  test("ok on 200", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await probeHealth({
      port: 3001,
      publicMode: false,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ state: "ok" });
  });

  test("unauthorized on 401", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    const result = await probeHealth({
      port: 3001,
      publicMode: true,
      authToken: "token",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe("unauthorized");
  });

  test("http_error on 500", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const result = await probeHealth({
      port: 3001,
      publicMode: false,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ state: "http_error", status: 500 });
  });

  test("unreachable when fetch throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await probeHealth({
      port: 3001,
      publicMode: false,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.state).toBe("unreachable");
  });

  test("sends bearer auth in public mode", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await probeHealth({
      port: 3001,
      publicMode: true,
      authToken: "secret",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const init = fetchFn.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer secret");
  });
});

describe("status", () => {
  test("reports stopped when intent flag is stopped", async () => {
    writeIntent("stopped");
    const result = await status({
      port: 3001,
      publicMode: false,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    expect(result.intent).toBe("stopped");
    expect(result.health).toBeNull();
  });

  test("skips health probe when pid is dead", async () => {
    writeIntent("running");
    // Pid 2^31 - 1 cannot exist on any sane system; process.kill returns ESRCH.
    writePid(2147483646);
    const fetchFn = vi.fn();
    const result = await status({
      port: 3001,
      publicMode: false,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.intent).toBe("running");
    expect(result.pidAlive).toBe(false);
    expect(result.health).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("includes log tail", async () => {
    const { outLog } = logPaths();
    mkdirSync(join(tmpHome, ".openclaw", "logs"), { recursive: true });
    writeFileSync(outLog, "alpha\nbeta\ngamma\n");
    writeIntent("stopped");

    const result = await status({
      port: 3001,
      publicMode: false,
      logTailLines: 2,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    expect(result.logTail).toEqual(["beta", "gamma"]);
  });
});

describe("formatStatus", () => {
  test("renders a useful summary", () => {
    const out = formatStatus({
      intent: "running",
      pid: 1234,
      pidAlive: true,
      uptimeMs: 60_000,
      port: 3001,
      publicMode: true,
      health: { state: "ok" },
      logTail: ["last line"],
    });
    expect(out).toContain("dashboard intent: running");
    expect(out).toContain("pid:");
    expect(out).toContain("port:             3001");
    expect(out).toContain("health:           healthy");
    expect(out).toContain("last line");
  });
});
