import { createServer, type Server } from "node:http";
// Tests for the per-session network broker (Stage S4-P1, XIN-1936 — Candidate 2).
//
// Two concerns:
//   1. Pure-unit — broker config shape, parentProxy hot-swap guard, and the
//      fail-closed spawn path. Run on every platform.
//   2. LIVE per-session network isolation — two concurrent brokers with
//      DIFFERENT allowlists, proving each reaches only its own domain, that a
//      control-fd re-scope takes effect live without touching the other broker,
//      and that brokers spawn / health-check / reap with no orphan survivors.
//      Gated to darwin + linux (the sandbox platforms); the identical matrix
//      runs under Seatbelt on macOS and under bwrap + netns on Linux.
//
// The isolation matrix is hermetic: two loopback origin servers stand in for
// two allow-listed domains. They are addressed as `*.localhost` names — a
// loopback NAME, so SRT's SSRF resolved-address guard permits the loopback
// answer (resolved-address-guard.js:162) — and the sandboxed curl clears
// no_proxy so the request actually traverses the broker's proxy rather than
// being bypassed as a localhost direct-connect.
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildBrokerRuntimeConfig, sameParentProxy } from "./broker-config.js";
import { ScopeChildReaper } from "./scope-reaper.js";
import {
  SessionBroker,
  SessionBrokerParentProxyError,
  SessionBrokerUnavailableError,
} from "./session-broker.js";

const isLive = process.platform === "darwin" || process.platform === "linux";
const LIVE_TIMEOUT = 60_000;

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectDeadWithin(pid: number | undefined, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  expect(isAlive(pid)).toBe(false);
}

// ── Pure-unit (all platforms) ────────────────────────────────────────────────

describe("broker config shape", () => {
  it("builds a working strict allowlist (empty denylist, strictAllowlist=true)", () => {
    const cfg = buildBrokerRuntimeConfig({
      writableRoots: ["/ws"],
      policy: { allowedDomains: [" a.example ", "a.example", "b.example"] },
    }) as { network: Record<string, unknown>; filesystem: Record<string, unknown> };
    // deniedDomains:["*"] would deny even an allow-listed host (deny wins first),
    // so a working allowlist is empty-deny + strictAllowlist.
    expect(cfg.network.deniedDomains).toEqual([]);
    expect(cfg.network.strictAllowlist).toBe(true);
    expect(cfg.network.allowedDomains).toEqual(["a.example", "b.example"]);
    expect(cfg.filesystem.allowWrite).toEqual(["/ws"]);
  });

  it("only carries parentProxy when configured", () => {
    const bare = buildBrokerRuntimeConfig({
      writableRoots: [],
      policy: { allowedDomains: [] },
    }) as { network: Record<string, unknown> };
    expect(bare.network.parentProxy).toBeUndefined();
    const withProxy = buildBrokerRuntimeConfig({
      writableRoots: [],
      policy: { allowedDomains: [], parentProxy: { http: "http://up:3128" } },
    }) as { network: Record<string, unknown> };
    expect(withProxy.network.parentProxy).toEqual({ http: "http://up:3128" });
  });

  it("sameParentProxy compares after normalization", () => {
    expect(sameParentProxy(undefined, undefined)).toBe(true);
    expect(sameParentProxy({ http: "http://p" }, { http: "http://p" })).toBe(true);
    expect(sameParentProxy({ http: "http://p" }, undefined)).toBe(false);
    expect(sameParentProxy({ http: "http://p" }, { http: "http://q" })).toBe(false);
  });
});

describe("session broker fail-closed + parentProxy guard", () => {
  const reapers: ScopeChildReaper[] = [];
  const brokers: SessionBroker[] = [];
  afterEach(() => {
    while (brokers.length) {
      brokers.pop()?.dispose();
    }
    while (reapers.length) {
      reapers.pop()?.dispose();
    }
  });

  it("AC-P1-4: a broker whose srt CLI cannot start fails closed (no unsandboxed fallback)", async () => {
    const reaper = new ScopeChildReaper();
    reapers.push(reaper);
    const broker = new SessionBroker({
      reaper,
      writableRoots: [],
      policy: { allowedDomains: ["a.example"] },
      cwd: process.cwd(),
      binShell: "/bin/bash",
      rpcTimeoutMs: 5_000,
      readyTimeoutMs: 8_000,
      // A path that does not exist: `node <bad>` exits non-zero, never reaching
      // the sandboxed executor, so no `ready` handshake ever arrives.
      srtCliPath: "/nonexistent/srt-cli-does-not-exist.js",
    });
    brokers.push(broker);
    await expect(broker.exec({ script: "echo hi" })).rejects.toBeInstanceOf(
      SessionBrokerUnavailableError,
    );
    expect(broker.isRunning).toBe(false);
  });

  it("AC-P1-5: refuses a live parentProxy change (not hot-swappable)", async () => {
    const reaper = new ScopeChildReaper();
    reapers.push(reaper);
    const broker = new SessionBroker({
      reaper,
      writableRoots: [],
      policy: { allowedDomains: ["a.example"], parentProxy: { http: "http://up:3128" } },
      cwd: process.cwd(),
      binShell: "/bin/bash",
      rpcTimeoutMs: 5_000,
    });
    brokers.push(broker);
    // Guard is evaluated before any broker spawn, so this needs no live srt.
    await expect(
      broker.setPolicy({
        allowedDomains: ["a.example"],
        parentProxy: { http: "http://different" },
      }),
    ).rejects.toBeInstanceOf(SessionBrokerParentProxyError);
  });
});

// ── LIVE per-session network isolation (darwin + linux) ──────────────────────

type Origin = { server: Server; server6?: Server; port: number; host: string; tag: string };

function startOrigin(tag: string, host: string): Promise<Origin> {
  return new Promise((resolve) => {
    const handler = (_req: unknown, res: import("node:http").ServerResponse) => {
      res.statusCode = 200;
      res.end(`ORIGIN=${tag}\n`);
    };
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      // Best-effort dual-stack: `*.localhost` may resolve to ::1 first at the
      // proxy's resolver, so answer there too when IPv6 loopback is available.
      const server6 = createServer(handler);
      server6.on("error", () => {
        resolve({ server, port, host, tag });
      });
      server6.listen(port, "::1", () => {
        resolve({ server, server6, port, host, tag });
      });
    });
  });
}

function stopOrigin(o: Origin | undefined): void {
  o?.server.close();
  o?.server6?.close();
}

describe.skipIf(!isLive)("session broker — live per-session network isolation (S4-P1)", () => {
  let alpha: Origin;
  let beta: Origin;
  const reapers: ScopeChildReaper[] = [];
  const brokers: SessionBroker[] = [];

  beforeAll(async () => {
    alpha = await startOrigin("ALPHA", "alpha.localhost");
    beta = await startOrigin("BETA", "beta.localhost");
  });
  afterAll(() => {
    stopOrigin(alpha);
    stopOrigin(beta);
  });
  afterEach(() => {
    while (brokers.length) {
      brokers.pop()?.dispose();
    }
    while (reapers.length) {
      reapers.pop()?.dispose();
    }
  });

  function makeBroker(allowedDomains: string[]): SessionBroker {
    const reaper = new ScopeChildReaper();
    reapers.push(reaper);
    const broker = new SessionBroker({
      reaper,
      writableRoots: [],
      policy: { allowedDomains },
      cwd: process.cwd(),
      binShell: "/bin/bash",
      rpcTimeoutMs: 30_000,
      readyTimeoutMs: 20_000,
    });
    brokers.push(broker);
    return broker;
  }

  /** curl a `*.localhost` origin through the broker; return the HTTP status. */
  async function httpCode(broker: SessionBroker, o: Origin): Promise<string> {
    const url = `http://${o.host}:${o.port}/`;
    const r = await broker.exec({
      // Clear no_proxy so the localhost request goes THROUGH the broker proxy
      // (SRT sets no_proxy=localhost,127.0.0.1,... which would otherwise bypass).
      script: `export no_proxy= NO_PROXY=; curl -s --max-time 15 -o /dev/null -w "%{http_code}" ${url}`,
    });
    return r.stdout.toString("utf8").trim();
  }

  it(
    "AC-P1-1: two concurrent brokers each reach only their own allow-listed domain",
    async () => {
      const a = makeBroker([`${alpha.host}:${alpha.port}`]);
      const b = makeBroker([`${beta.host}:${beta.port}`]);
      // Concurrent, cross-checked in both directions.
      const [aToAlpha, aToBeta, bToBeta, bToAlpha] = await Promise.all([
        httpCode(a, alpha),
        httpCode(a, beta),
        httpCode(b, beta),
        httpCode(b, alpha),
      ]);
      expect(aToAlpha).toBe("200"); // A reaches its own domain
      expect(aToBeta).toBe("403"); // A cannot reach B's domain (proxy denies)
      expect(bToBeta).toBe("200"); // B reaches its own domain
      expect(bToAlpha).toBe("403"); // B cannot reach A's domain
    },
    LIVE_TIMEOUT,
  );

  it(
    "AC-P1-2: a control-fd re-scope takes effect live and does not affect the other broker",
    async () => {
      const a = makeBroker([`${alpha.host}:${alpha.port}`]);
      const b = makeBroker([`${beta.host}:${beta.port}`]);
      // Baseline.
      expect(await httpCode(a, alpha)).toBe("200");
      expect(await httpCode(a, beta)).toBe("403");
      // Live re-scope broker A to beta only — no restart.
      await a.setAllowedDomains([`${beta.host}:${beta.port}`]);
      expect(a.currentAllowedDomains).toEqual([`${beta.host}:${beta.port}`]);
      expect(await httpCode(a, beta)).toBe("200"); // now allowed
      expect(await httpCode(a, alpha)).toBe("403"); // now denied
      // Broker B is untouched by A's re-scope.
      expect(await httpCode(b, beta)).toBe("200");
      expect(await httpCode(b, alpha)).toBe("403");
    },
    LIVE_TIMEOUT,
  );

  it(
    "AC-P1-3: broker spawns, health-checks (ping), and reaps with no orphan process",
    async () => {
      const a = makeBroker([`${alpha.host}:${alpha.port}`]);
      // Spawn is lazy: the first exec brings the broker up.
      expect(await httpCode(a, alpha)).toBe("200");
      const pong = await a.ping();
      expect(pong.pid).toBeGreaterThan(0);
      const pid = a.pid;
      expect(isAlive(pid)).toBe(true);
      a.dispose();
      await expectDeadWithin(pid);
      expect(a.isRunning).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  it(
    "AC-P1-4 (live): a killed broker fails in-flight/next calls closed, then respawns sandboxed",
    async () => {
      const a = makeBroker([`${alpha.host}:${alpha.port}`]);
      expect(await httpCode(a, alpha)).toBe("200");
      const pid = a.pid;
      // Simulate a broker crash by group-killing it.
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          process.kill(pid, "SIGKILL");
        }
      }
      await expectDeadWithin(pid);
      // The session never falls back to unsandboxed: a respawn is still a
      // fresh, same-policy sandboxed broker enforcing the same allowlist.
      expect(await httpCode(a, alpha)).toBe("200");
      expect(await httpCode(a, beta)).toBe("403");
    },
    LIVE_TIMEOUT,
  );

  // AC-P1-7 / AC-P1-3 resource accounting. Linux-only: reads /proc for the
  // broker subtree (srt node + bwrap + socat bridge), reports per-broker cost at
  // a stated concurrency, and asserts the whole subtree reaps back to baseline.
  it.skipIf(process.platform !== "linux")(
    "AC-P1-7: measures per-broker resource cost and reaps to baseline (no orphan proc/fd/socat)",
    async () => {
      const { readFileSync, readdirSync } = await import("node:fs");
      type Snap = { procs: number; socat: number; bwrap: number; rssKb: number; selfFds: number };
      const readProcs = (): Snap => {
        let procs = 0;
        let socat = 0;
        let bwrap = 0;
        let rssKb = 0;
        for (const pid of readdirSync("/proc")) {
          if (!/^\d+$/.test(pid)) {
            continue;
          }
          let cmdline: string;
          let comm: string;
          try {
            cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
            comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
          } catch {
            continue;
          }
          const isBroker = cmdline.includes("cli.js") && cmdline.includes("--control-fd");
          const isSocat = comm === "socat";
          const isBwrap = comm === "bwrap";
          if (!isBroker && !isSocat && !isBwrap) {
            continue;
          }
          procs += 1;
          if (isSocat) {
            socat += 1;
          }
          if (isBwrap) {
            bwrap += 1;
          }
          try {
            const status = readFileSync(`/proc/${pid}/status`, "utf8");
            const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
            if (m) {
              rssKb += Number(m[1]);
            }
          } catch {
            // process may have exited between readdir and read
          }
        }
        return { procs, socat, bwrap, rssKb, selfFds: readdirSync("/proc/self/fd").length };
      };

      const baseline = readProcs();
      const N = 4;
      const fleet = Array.from({ length: N }, () => makeBroker([`${alpha.host}:${alpha.port}`]));
      // Bring every broker up and prove each enforces its scope.
      const codes = await Promise.all(fleet.map((b) => httpCode(b, alpha)));
      expect(codes).toEqual(Array.from({ length: N }, () => "200"));
      const active = readProcs();

      const brokerProcs = active.procs - baseline.procs;
      const perBrokerRssMb = (active.rssKb - baseline.rssKb) / 1024 / N;
      console.log(
        `[AC-P1-7] concurrency=${N} broker-subtree procs=${brokerProcs} ` +
          `(socat=${active.socat - baseline.socat}, bwrap=${active.bwrap - baseline.bwrap}) ` +
          `RSS≈${((active.rssKb - baseline.rssKb) / 1024).toFixed(1)}MB total, ` +
          `≈${perBrokerRssMb.toFixed(1)}MB/broker; self-fds ${baseline.selfFds}->${active.selfFds}`,
      );
      // Every broker contributes at least a socat bridge on Linux.
      expect(active.socat - baseline.socat).toBeGreaterThanOrEqual(N);

      // Reap all and assert the subtree returns to baseline.
      for (const b of fleet) {
        b.dispose();
      }
      let settled = readProcs();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && settled.procs > baseline.procs) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        settled = readProcs();
      }
      console.log(
        `[AC-P1-7] after reap: broker-subtree procs=${settled.procs - baseline.procs} ` +
          `socat=${settled.socat - baseline.socat} bwrap=${settled.bwrap - baseline.bwrap} ` +
          `self-fds=${settled.selfFds}`,
      );
      expect(settled.procs).toBeLessThanOrEqual(baseline.procs);
      expect(settled.socat).toBeLessThanOrEqual(baseline.socat);
      expect(settled.bwrap).toBeLessThanOrEqual(baseline.bwrap);
    },
    LIVE_TIMEOUT,
  );
});
