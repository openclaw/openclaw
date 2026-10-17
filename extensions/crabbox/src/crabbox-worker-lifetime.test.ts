import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { prepareCrabboxCaptureLifetime } from "./crabbox-worker-lifetime.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { inspectWithContext } from "./crabbox-worker-provision-commands.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const ID = "cbx_012345abcdef";
const context = {
  sourcePreparationTimeoutMs: 15 * 60_000,
  binary: "/fixture/crabbox",
  id: ID,
  provider: "aws",
  profile: parseCrabboxProfile({ provider: "aws", ttl: "4h", idleTimeout: "45m" }),
};
const jsonResult = (value: unknown) => commandResult({ stdout: JSON.stringify(value) });

function fixture(
  options: { ttl?: number; extension?: string; runtime?: boolean; expiry?: number } = {},
) {
  let ttl = options.ttl ?? 1800;
  const calls: string[][] = [];
  const observation = vi.fn();
  const facts = () => ({
    id: ID,
    state: "active",
    provider: "aws",
    createdAt: new Date(NOW).toISOString(),
    ttlSeconds: ttl,
    idleTimeout: "45m",
    expiresAt: new Date(NOW + (options.expiry ?? 2700) * 1000).toISOString(),
    leasePolicy: {
      maxTTLSeconds: 14400,
      runtimeExtension: options.runtime ?? true,
      extension: options.extension ?? "allow",
    },
  });
  let extend: CrabboxCommandRunner | undefined;
  const runCommand: CrabboxCommandRunner = async (argv, settings) => {
    calls.push(argv);
    if (argv[1] === "extend") {
      if (extend) {
        return extend(argv, settings);
      }
      ttl = Number(argv[argv.indexOf("--ttl") + 1]!.slice(0, -1));
      return jsonResult({ id: ID, runtimeExtension: true });
    }
    if (argv[1] === "inspect") {
      // Coordinator inspect omits the creation anchor and total TTL.
      const { createdAt: _created, ttlSeconds: _ttl, ...inspect } = facts();
      return jsonResult(inspect);
    }
    if (argv[1] === "list") {
      return jsonResult([facts()]);
    }
    return jsonResult(facts());
  };
  vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(runCommand);
  return {
    calls,
    observation,
    prepare: (overrides: Partial<typeof context> = {}) =>
      prepareCrabboxCaptureLifetime({ ...context, ...overrides }, { observe: observation }),
    actions: () => calls.map((call) => call[1]),
    writes: () => calls.filter((call) => call[1] === "extend"),
    setExtension: (run: CrabboxCommandRunner) => {
      extend = run;
    },
    setTTL: (value: number) => {
      ttl = value;
    },
  };
}

describe("Crabbox capture lifetime admission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("never echoes connection JSON from a failed inspection", async () => {
    vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async () =>
      commandResult({
        code: 1,
        stdout: JSON.stringify({
          sshHost: "private-host",
          sshKey: "/private/key",
          sshHostKey: "private-host-key",
        }),
        stderr: "provider temporarily unavailable",
      }),
    );
    const failure = inspectWithContext(context);
    await expect(failure).rejects.toThrow("provider temporarily unavailable");
    await expect(failure).rejects.not.toThrow("private");
  });

  it("distinguishes idle expiry from total TTL without extending an adequate lease", async () => {
    const f = fixture({ ttl: 14400 });
    await f.prepare();
    expect(f.actions()).toEqual(["inspect", "heartbeat", "inspect", "list"]);
    expect(f.observation.mock.lastCall?.[0].lifetime).toMatchObject({
      ttlMs: 14400000,
      createdAtMs: NOW,
    });
  });

  it.each(["inspect", "list"] as const)(
    "honors a tightened maximum when total TTL comes from %s",
    async (source) => {
      const facts = {
        id: ID,
        provider: "aws",
        state: "active",
        createdAt: new Date(NOW - 60 * 60_000).toISOString(),
        ttlSeconds: 14400,
        expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
        leasePolicy: { maxTTLSeconds: 5400, runtimeExtension: true, extension: "allow" },
      };
      const runCommand = vi.fn<CrabboxCommandRunner>(async (argv) => {
        const { createdAt, ttlSeconds, leasePolicy, ...inspect } = facts;
        const value =
          argv[1] === "list"
            ? [{ ...inspect, createdAt, ttlSeconds }]
            : {
                ...inspect,
                leasePolicy,
                ...(source === "inspect" ? { createdAt, ttlSeconds } : {}),
              };
        return jsonResult(value);
      });
      vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(runCommand);
      await expect(prepareCrabboxCaptureLifetime(context, { observe: vi.fn() })).rejects.toThrow(
        "required source window exceeds the configured TTL or effective maximum",
      );
      expect(runCommand.mock.calls.some(([argv]) => argv[1] === "extend")).toBe(false);
    },
  );

  it("requests one bounded total target and verifies authoritative readback", async () => {
    const f = fixture();
    f.setExtension(async () => {
      // Extension and readback consume real lease lifetime.
      vi.advanceTimersByTime(30_000);
      f.setTTL(4440);
      return jsonResult({ id: ID });
    });
    await f.prepare();
    expect(f.writes()).toEqual([
      ["/fixture/crabbox", "extend", ID, "--provider", "aws", "--ttl", "4440s", "--json"],
    ]);
    expect(f.actions().slice(-2)).toEqual(["inspect", "list"]);
  });

  it("admits the actual longer runtime preparation budget", async () => {
    const f = fixture();
    f.setExtension(async () => {
      f.setTTL(5340);
      return jsonResult({ id: ID });
    });
    await f.prepare({ sourcePreparationTimeoutMs: 30 * 60_000 });
    expect(f.writes()[0]).toContain("5340s");
  });

  it("surfaces coordinator refusal without a retry or replacement", async () => {
    const code = "lease_extension_budget_exceeded";
    const f = fixture();
    f.setExtension(async () => commandResult({ code: 1, stderr: `coordinator: ${code}` }));
    await expect(f.prepare()).rejects.toThrow(code);
    expect(f.writes()).toHaveLength(1);
    expect(f.actions()).not.toContain("warmup");
  });

  it.each([{ runtime: false }, { extension: "deny" }])(
    "rejects unsupported/denied policy before an extension",
    async (policy) => {
      const f = fixture(policy);
      await expect(f.prepare()).rejects.toThrow(/lease_extension_(unsupported_provider|denied)/u);
      expect(f.writes()).toEqual([]);
    },
  );

  it("replays the exact target once for a partial direct guest refresh", async () => {
    const f = fixture();
    let attempts = 0;
    f.setExtension(async () => {
      if (attempts++ === 0) {
        return commandResult({
          code: 1,
          stdout: JSON.stringify({
            id: ID,
            guestExpiryRefreshPending: true,
            error: "guest refresh failed",
          }),
        });
      }
      f.setTTL(4440);
      return jsonResult({ id: ID });
    });
    await f.prepare();
    const writes = f.writes();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  });

  it("rejects persistent guest-refresh failure even when provider TTL advanced", async () => {
    const f = fixture();
    f.setExtension(async () => {
      f.setTTL(14400);
      return commandResult({
        code: 1,
        stdout: JSON.stringify({ id: ID, guestExpiryRefreshPending: true }),
      });
    });
    await expect(f.prepare()).rejects.toThrow("guest expiry refresh remains unconfirmed");
    expect(f.writes()).toHaveLength(2);
  });

  it("rejects ambiguous success and never exceeds the operator's intended TTL", async () => {
    const f = fixture();
    f.setExtension(async () => jsonResult({ id: ID }));
    await expect(f.prepare()).rejects.toThrow("did not confirm sufficient");
    f.calls.length = 0;
    await expect(
      f.prepare({
        profile: parseCrabboxProfile({ provider: "aws", ttl: "1h", idleTimeout: "45m" }),
      }),
    ).rejects.toThrow("exceeds the configured TTL");
    expect(f.writes()).toEqual([]);
  });
});
