import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, vi } from "vitest";
import { scenario } from "./crabbox-warm-provider-scenarios.test-support.js";
import {
  warmImage,
  warmRecord,
  warmAllocation,
  captureOperation,
  expectText,
} from "./crabbox-warm-scenarios.test-support.js";
import { destroyAndWait, commandResult } from "./crabbox-worker-provider.test-support.js";
import { managedBinary, PROFILE } from "./crabbox-worker-warm-image.test-support.js";

const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const REFRESH_MS = 24 * 60 * 60 * 1_000;
const retirement = { type: "retire", checkpointId: "chk_expired" };
const deletion = ["checkpoint", "delete", "chk_expired"];
const deletionArgs = (...binaries: string[]) => binaries.map((binary) => [binary].concat(deletion));
const absence = () => commandResult({ stdout: "checkpoint absent id=chk_expired\n" });
const freezeTime = (now = 2 * REFRESH_MS) => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  return now;
};
const captureUnsupported = (atMs: number) => ({
  atMs,
  provider: "hetzner",
  message: "Native capture is unsupported by this coordinator",
});
const coldRecord = (atMs: number) => warmRecord({ captureUnsupported: captureUnsupported(atMs) });
const retainedColdProfile = (atMs: number) =>
  warmRecord({
    captureUnsupported: captureUnsupported(atMs),
    allocations: { cbx_retained: warmAllocation() },
  });
const context = () => ({
  profiles: [PROFILE],
  signal: new AbortController().signal,
  assertCurrent() {},
});
const mixedContext = () => ({
  ...context(),
  profiles: [
    { ...PROFILE, binary: "/opt/b/crabbox" },
    { ...PROFILE, binary: "/opt/a/crabbox" },
    { ...PROFILE, binary: "/opt/a/crabbox" },
  ],
});
const expiredImage = (
  id: string,
  createdAtMs = Date.now() - RETENTION_MS,
  lastDemandAtMs: number | null = createdAtMs,
) =>
  warmRecord({
    image: warmImage(id, { kind: "aws-ebs-snapshot", createdAtMs, lastDemandAtMs }),
  });

it.each([REFRESH_MS - 1, REFRESH_MS])(
  "retains refusal after last release (age=%i)",
  async (age) => {
    const now = freezeTime();
    const s = scenario();
    const record = retainedColdProfile(now - age);
    s.store.register("retained", record);

    await destroyAndWait(s.provider, {
      leaseId: "cbx_retained",
      profile: { ...PROFILE, warmImage: false },
    });

    expect(s.store.lookup("retained")).toEqual(
      age < REFRESH_MS ? { ...record, allocations: {} } : undefined,
    );
    expect(s.calls.map(({ argv }) => argv[1])).toEqual(["stop"]);
  },
);

it("collects expired markers but keeps active owners", async () => {
  const now = freezeTime();
  const s = scenario();
  const held = retainedColdProfile(now - REFRESH_MS);
  const active = coldRecord(now);
  s.store.register("retained", held);
  s.store.register("active", active);
  s.store.register("expired", coldRecord(now - REFRESH_MS));

  await s.provider.maintain!(context());

  expect(s.store.lookup("expired")).toBeUndefined();
  expect(s.store.lookup("active")).toEqual(active);
  expect(s.store.lookup("retained")).toEqual(held);
  expect(s.calls).toEqual([]);
});

it.each([false, true])("reclaims refusal capacity (withImage=%s)", async (withImage) => {
  const now = freezeTime();
  const s = scenario();
  for (let index = 0; index < 128; index += 1) {
    s.store.register(
      `cold-only-${index}`,
      warmRecord({
        captureUnsupported: captureUnsupported(now),
        ...(withImage
          ? {
              image: expiredImage(`chk_refused_${index}`, now - 3_600_000).image!,
            }
          : {}),
      }),
    );
  }

  const lease = await s.provision();

  expect(s.store.entries()).toHaveLength(128);
  expect(s.store.entries().filter(({ value }) => value.captureUnsupported)).toHaveLength(127);
  expect(s.store.entries().some(({ value }) => value.allocations[lease.leaseId])).toBe(true);
  expect(
    s.calls.filter(({ argv }) => argv[1] === "checkpoint").map(({ argv }) => argv.slice(1)),
  ).toEqual(withImage ? [["checkpoint", "delete", "chk_refused_0"]] : []);
});

it.each([false, true])("handles binary acquisition failure (all=%s)", async (all) => {
  const s = scenario();
  const expired = expiredImage("chk_expired");
  s.store.register("expired", expired);
  vi.spyOn(managedBinary, "ensureManagedCrabboxBinary").mockImplementation(async (params) => {
    if (all || params?.binary === "/opt/b/crabbox") {
      throw new Error("fixture binary acquisition unavailable");
    }
    return { binary: params?.binary ?? "crabbox", version: "999.0.0" };
  });
  const maintenance = s.provider.maintain!(mixedContext());
  if (all) {
    await expect(maintenance).rejects.toThrow();
    expect(s.calls).toEqual([]);
    expect(s.store.lookup("expired")).toEqual(expired);
  } else {
    await maintenance;
    expect(s.calls.map(({ argv }) => argv)).toEqual(deletionArgs("/opt/a/crabbox"));
    expect(s.store.lookup("expired")).toBeUndefined();
    expect(s.warn).toHaveBeenCalledWith(
      expect.stringContaining("fixture binary acquisition unavailable"),
    );
  }
});

it.each(["creating", "uncertain"] as const)(
  "reports old %s captures without stealing ownership",
  async (phase) => {
    const s = scenario();
    const recent = expiredImage("chk_recent");
    recent.image!.lastDemandAtMs = Date.now();
    const pinned = expiredImage("chk_pinned");
    pinned.allocations.cbx_pending = warmAllocation({
      kind: "checkpoint",
      checkpointId: "chk_pinned",
    });
    const capturing = expiredImage("chk_capturing");
    capturing.operation = captureOperation("capture-owner", {
      phase,
      startedAtMs: Date.now() - 1_200_000,
    });
    for (const [key, record] of Object.entries({ recent, pinned, capturing })) {
      s.store.register(key, record);
    }
    s.store.register("expired", expiredImage("chk_expired"));
    const profile = {
      ...PROFILE,
      setup: "echo configured",
      setupSecrets: {
        MAINTENANCE_INPUT: { source: "store", provider: "default", id: "NOT_LOADED" },
      },
      warmImage: false,
    };

    await s.provider.maintain!({ ...context(), profiles: [profile] });

    expect(s.calls.map(({ argv }) => argv.slice(1))).toEqual([deletion]);
    expect(s.store.lookup("expired")).toBeUndefined();
    expect(s.warn).toHaveBeenCalledOnce();
    expect(s.warn.mock.calls[0]?.[0]).toContain("capture-owner");
    if (phase === "uncertain") {
      expect(s.warn.mock.calls[0]?.[0]).toContain("--recover capture-owner");
    } else {
      expectText(
        s.warn.mock.calls[0]?.[0],
        ["may still be"],
        ["--recover", "Stop the owning Gateway", "failed"],
      );
    }
    for (const [key, record] of Object.entries({ recent, pinned, capturing })) {
      expect(s.store.lookup(key)).toEqual(record);
    }
  },
);

it("deduplicates paused-capture reports by ownership", async () => {
  const s = scenario();
  const pausedCapture = (id: string, startedAtMs = Date.now() - 1_200_000) =>
    warmRecord({ operation: captureOperation(id, { phase: "uncertain", startedAtMs }) });
  const records = Array.from({ length: 4 }, (_, index) => pausedCapture(`capture-${index}`));
  records.forEach((record, index) => s.store.register(`profile-${index}`, record));

  await s.provider.maintain!(context());
  await s.provider.maintain!(context());

  expect(s.warn).toHaveBeenCalledOnce();
  const warning = s.warn.mock.calls[0]?.[0];
  expectText(
    warning,
    ["4", "paused", "Stop the owning Gateway", "--acknowledge-provider-cleanup"],
    ["failed"],
  );
  for (const [index, record] of records.entries()) {
    expect(warning).toContain(`capture-${index}`);
    expect(s.store.lookup(`profile-${index}`)).toEqual(record);
  }
  expect(s.calls).toEqual([]);

  s.store.register("profile-0", pausedCapture("replacement-capture", Date.now()));
  await s.provider.maintain!(context());
  expect(s.warn).toHaveBeenCalledTimes(2);
  expect(s.warn.mock.calls[1]?.[0]).toContain("replacement-capture");
  records.forEach((_, index) => s.store.register(`profile-${index}`, warmRecord()));
  await s.provider.maintain!(context());
  expect(s.warn).toHaveBeenCalledTimes(2);
  records.forEach((record, index) => s.store.register(`profile-${index}`, record));
  await s.provider.maintain!(context());
  expect(s.warn).toHaveBeenCalledTimes(3);
  expect(s.warn.mock.calls[2]?.[0]).toBe(warning);
  expect(s.calls).toEqual([]);
});

it.each(["dispose", "authority", "operator delete"] as const)(
  "fences %s deletion until an active retry",
  async (boundary) => {
    const started = createDeferred<AbortSignal>();
    const finish = createDeferred<void>();
    const s = scenario(async ({ argv, options }) => {
      if (argv[2] !== "delete") {
        return undefined;
      }
      started.resolve(options.signal!);
      await finish.promise;
      return absence();
    });
    s.store.register("expired", expiredImage("chk_expired"));
    let current = true;
    const maintenance =
      boundary === "operator delete"
        ? s.provider.images.delete("chk_expired", mixedContext().profiles)
        : s.provider.maintain!({
            ...mixedContext(),
            assertCurrent() {
              if (!current) {
                throw new Error("maintenance authority closed");
              }
            },
          });
    const rejected = expect(maintenance).rejects.toThrow();
    let stopping: Promise<void> | undefined;
    let stopped = false;
    try {
      const signal = await started.promise;
      // Allocation has its own queue and must not wait on the pending deletion.
      await expect(s.provision("during-maintenance")).resolves.toMatchObject({
        node: { deviceId: "device-1" },
      });
      current = false;
      if (boundary !== "authority") {
        stopping = s.provider.dispose().then(() => {
          stopped = true;
        });
        expect(signal.aborted).toBe(true);
        await Promise.resolve();
        expect(stopped).toBe(false);
      }
    } finally {
      finish.resolve();
      await rejected;
      await stopping;
    }
    expect(s.store.lookup("expired")?.operation).toEqual(retirement);
    expect(s.checkpoints("delete")).toEqual(deletionArgs("/opt/a/crabbox"));
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const replacement = scenario(absence, s.stateDir);
    await replacement.provider.maintain!(context());
    expect(replacement.store.lookup("expired")).toBeUndefined();
    await replacement.provider.maintain!(context());
    expect(replacement.calls.map(({ argv }) => argv.slice(1))).toEqual([deletion]);
    if (boundary !== "authority") {
      expect(stopped).toBe(true);
      expect(() => s.provider.maintain!(context())).toThrow();
      await expect(s.provider.images.pin("chk_expired", true)).rejects.toThrow();
      await expect(s.provider.images.rollback("chk_expired")).rejects.toThrow();
      await expect(s.provider.images.delete("chk_expired", context().profiles)).rejects.toThrow();
    }
  },
);

it("deletes across catalogs in executable order", async () => {
  const s = scenario(({ argv }) => {
    const known =
      (argv[0] === "/opt/a/crabbox" && argv[3] === "chk_a") ||
      (argv[0] === "/opt/b/crabbox" && argv[3] === "chk_b");
    return commandResult({
      stdout: `catalog response\n  checkpoint ${known ? "deleted" : "absent"} id=${argv[3]}  \n`,
    });
  });
  for (const id of ["chk_a", "chk_b", "chk_nowhere"]) {
    s.store.register(id, expiredImage(id));
  }

  await s.provider.maintain!(mixedContext());

  for (const id of ["chk_a", "chk_b", "chk_nowhere"]) {
    expect(s.store.lookup(id)).toBeUndefined();
    expect(s.calls.filter(({ argv }) => argv[3] === id).map(({ argv }) => argv)).toEqual(
      (id === "chk_a" ? ["/opt/a/crabbox"] : ["/opt/a/crabbox", "/opt/b/crabbox"]).map((binary) => [
        binary,
        "checkpoint",
        "delete",
        id,
      ]),
    );
  }
  expect(s.calls).toHaveLength(5);
  expect(s.warn).not.toHaveBeenCalled();
});

it.each(["exit", "command"])("retains deletion on first-catalog %s errors", async (failure) => {
  let fails = true;
  const s = scenario(() => {
    if (!fails) {
      return absence();
    }
    if (failure === "command") {
      throw new Error("fixture command unavailable");
    }
    return commandResult({ code: 7, stderr: "fixture deletion unavailable" });
  });
  s.store.register("expired", expiredImage("chk_expired"));

  await s.provider.maintain!(mixedContext());
  await s.provider.maintain!(mixedContext());

  expect(s.store.lookup("expired")?.operation).toEqual(retirement);
  expect(s.calls.map(({ argv }) => argv)).toEqual(deletionArgs("/opt/a/crabbox", "/opt/a/crabbox"));
  expect(s.warn).toHaveBeenCalledOnce();
  expect(s.warn).toHaveBeenCalledWith(expect.stringContaining("deletion obligation retained"));
  fails = false;
  s.calls.length = 0;
  await s.provider.maintain!(context());
  expect(s.store.lookup("expired")).toBeUndefined();
  expect(s.calls.map(({ argv }) => argv.slice(1))).toEqual([deletion]);
  expect(s.warn).toHaveBeenCalledOnce();
});

it.each([
  { elapsed: 20_000, rewind: false },
  { elapsed: 60_000, rewind: false },
  { elapsed: 20_000, rewind: true },
])("shares catalog deadlines (rewind=$rewind, elapsed=$elapsed)", async ({ elapsed, rewind }) => {
  let monotonicMs = 0;
  const monotonic = vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const s = scenario(() => {
    monotonicMs += elapsed;
    return absence();
  });
  s.store.register(
    "expired",
    rewind ? expiredImage("chk_expired", 0, null) : expiredImage("chk_expired"),
  );
  if (rewind) {
    let reads = 0;
    clock.mockImplementation(() => (++reads === 1 ? 0 : -90_000));
  } else {
    s.store.register("expired-cold-only", coldRecord(now - REFRESH_MS));
  }
  try {
    await s.provider.maintain!(mixedContext());
  } finally {
    monotonic.mockRestore();
    clock.mockRestore();
  }
  expect(s.calls.map(({ argv, options }) => [argv[0], options.timeoutMs])).toEqual(
    elapsed < 60_000
      ? [
          ["/opt/a/crabbox", 60_000],
          ["/opt/b/crabbox", 40_000],
        ]
      : [["/opt/a/crabbox", 60_000]],
  );
  if (elapsed < 60_000) {
    expect(s.store.lookup("expired")).toBeUndefined();
    if (!rewind) {
      expect(s.store.lookup("expired-cold-only")).toBeUndefined();
    }
  } else {
    expect(s.store.lookup("expired")?.operation).toEqual(retirement);
    expect(s.store.lookup("expired-cold-only")?.captureUnsupported).toBeDefined();
  }
  expect(s.warn).not.toHaveBeenCalled();
});

it("matches absence receipts to the exact checkpoint", async () => {
  const s = scenario(() => commandResult({ stdout: "checkpoint absent id=chk_expired_other\n" }));
  s.store.register("expired", expiredImage("chk_expired"));

  await s.provider.maintain!(mixedContext());

  expect(s.calls.map(({ argv }) => argv)).toEqual(deletionArgs("/opt/a/crabbox"));
  expect(s.store.lookup("expired")).toBeUndefined();
  expect(s.warn).not.toHaveBeenCalled();
});
