import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import { prepareCrabboxCaptureLifetime } from "./crabbox-worker-lifetime.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { inspectWithContext } from "./crabbox-worker-provision-commands.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const ID = "cbx_012345abcdef";
const profile = (ttl: string) => parseCrabboxProfile({ provider: "aws", ttl, idleTimeout: "45m" });
const context = {
  sourcePreparationTimeoutMs: 15 * 60_000,
  binary: "/fixture/crabbox",
  id: ID,
  provider: "aws",
  profile: profile("4h"),
};
const jsonResult = (value: unknown, code = 0, stderr = "") =>
  commandResult({ code, stderr, stdout: JSON.stringify(value) });
const LEASE = {
  id: ID,
  state: "active",
  provider: "aws",
  createdAt: new Date(NOW).toISOString(),
  ttlSeconds: 1800,
  idleTimeout: "45m",
  expiresAt: new Date(NOW + 2700_000).toISOString(),
  leasePolicy: { maxTTLSeconds: 14400, runtimeExtension: true, extension: "allow" },
};

function fixture(patch: Partial<typeof LEASE> = {}, source?: "inspect" | "list") {
  const state = { ...LEASE, ...patch };
  const extend = vi.fn(async () => jsonResult({ id: ID }));
  const calls: string[][] = [];
  vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async (argv) => {
    calls.push(argv);
    if (argv[1] === "extend") {
      return extend();
    }
    const { createdAt, ttlSeconds, leasePolicy, ...common } = state;
    if (argv[1] === "inspect") {
      // Coordinator inspect omits the creation anchor and total TTL.
      return jsonResult(source === "inspect" ? state : { ...common, leasePolicy });
    }
    if (argv[1] === "list") {
      return jsonResult([source ? { ...common, createdAt, ttlSeconds } : state]);
    }
    return jsonResult(state);
  });
  return {
    state,
    extend,
    calls,
    prepare: (overrides: Partial<typeof context> = {}) =>
      prepareCrabboxCaptureLifetime({ ...context, ...overrides }, { observe() {} }),
    actions: () => calls.map((call) => call[1]),
    writes: () => calls.filter((call) => call[1] === "extend"),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("never echoes connection JSON from a failed inspection", async () => {
  vi.spyOn(processRunner, "runCrabboxProcess").mockResolvedValue(
    jsonResult(
      { sshHost: "private-host", sshKey: "/private/key", sshHostKey: "private-pin" },
      1,
      "provider temporarily unavailable",
    ),
  );
  const failure = inspectWithContext(context);
  await expect(failure).rejects.toThrow("provider temporarily unavailable");
  await expect(failure).rejects.not.toThrow("private");
});

it("distinguishes idle expiry from total TTL without extending an adequate lease", async () => {
  const f = fixture({ ttlSeconds: 14400 });
  await f.prepare();
  expect(f.writes()).toEqual([]);
});

it.each(["inspect", "list"] as const)("honors the tightened maximum from %s", async (source) => {
  const f = fixture(
    {
      ttlSeconds: 14400,
      createdAt: new Date(NOW - 3600_000).toISOString(),
      leasePolicy: { ...LEASE.leasePolicy, maxTTLSeconds: 5400 },
    },
    source,
  );
  await expect(f.prepare()).rejects.toThrow(
    "required source window exceeds the configured TTL or effective maximum",
  );
  expect(f.writes()).toEqual([]);
});

it.each([
  { budget: 15, target: 4440, elapsed: 30_000 },
  { budget: 30, target: 5340, elapsed: 0 },
])(
  "admits a $budget minute budget with one bounded, verified extension",
  async ({ budget, target, elapsed }) => {
    const f = fixture();
    f.extend.mockImplementation(async () => {
      vi.advanceTimersByTime(elapsed);
      f.state.ttlSeconds = target;
      return jsonResult({ id: ID });
    });
    await f.prepare({ sourcePreparationTimeoutMs: budget * 60_000 });
    expect(f.writes()).toEqual([
      ["/fixture/crabbox", "extend", ID, "--provider", "aws", "--ttl", `${target}s`, "--json"],
    ]);
  },
);

it("surfaces coordinator refusal without a retry or replacement", async () => {
  const code = "lease_extension_budget_exceeded";
  const f = fixture();
  f.extend.mockResolvedValue(commandResult({ code: 1, stderr: `coordinator: ${code}` }));
  await expect(f.prepare()).rejects.toThrow(code);
  expect(f.writes()).toHaveLength(1);
  expect(f.actions()).not.toContain("warmup");
});

it.each([{ runtimeExtension: false }, { extension: "deny" }])(
  "rejects policy before extending",
  async (policy) => {
    const f = fixture({ leasePolicy: { ...LEASE.leasePolicy, ...policy } });
    await expect(f.prepare()).rejects.toThrow(/lease_extension_(unsupported_provider|denied)/u);
    expect(f.writes()).toEqual([]);
  },
);

it.each([true, false])("settles guest-refresh once (recovered=%s)", async (recovered) => {
  const f = fixture();
  const pending = { id: ID, guestExpiryRefreshPending: true };
  let attempts = 0;
  f.extend.mockImplementation(async () => {
    if (recovered && attempts++ > 0) {
      f.state.ttlSeconds = 4440;
      return jsonResult({ id: ID });
    }
    if (!recovered) {
      f.state.ttlSeconds = 14400;
    }
    return jsonResult(recovered ? { ...pending, error: "guest refresh failed" } : pending, 1);
  });
  if (recovered) {
    await f.prepare();
  } else {
    await expect(f.prepare()).rejects.toThrow("guest expiry refresh remains unconfirmed");
  }
  const writes = f.writes();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

it("rejects ambiguous success and never exceeds the operator's intended TTL", async () => {
  const f = fixture();
  await expect(f.prepare()).rejects.toThrow("did not confirm sufficient");
  f.calls.length = 0;
  await expect(f.prepare({ profile: profile("1h") })).rejects.toThrow("exceeds the configured TTL");
  expect(f.writes()).toEqual([]);
});
