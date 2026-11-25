import { expect, it, vi } from "vitest";
import { scenario } from "./crabbox-warm-provider-scenarios.test-support.js";
import {
  captureOperation,
  warmAllocation,
  warmImage,
  warmRecord,
} from "./crabbox-warm-scenarios.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { jsonResult, PROFILE } from "./crabbox-worker-warm-image.test-support.js";

const leaseId = "cbx_interrupted";
const capture = () =>
  captureOperation("interrupted", { phase: "uncertain", leaseId, provider: "aws" });
const context = () => ({
  profiles: [PROFILE],
  signal: new AbortController().signal,
  assertCurrent() {},
});
const absent = () => commandResult({ code: 4, stderr: `aws instance not found: ${leaseId}` });
const candidates = ["chk_interrupted_a", "chk_interrupted_b"];
const checkpoints = (ids: string[]) => ids.map((id) => ({ id, leaseId, provider: "aws" }));
type Reply = () => ReturnType<typeof commandResult> | undefined;
function reconciliation(replies: Record<string, Reply>, info?: (message: string) => void) {
  return scenario(
    ({ argv }) => replies[argv[1] === "inspect" ? "inspect" : argv[2]!]?.(),
    undefined,
    { info },
  );
}
const failed = (stderr: string, code = 7) => commandResult({ code, stderr });
const candidateIds = (s: ReturnType<typeof scenario>) =>
  s.checkpoints("delete").map((argv) => argv[3]);
const register = (
  s: ReturnType<typeof scenario>,
  overrides: Parameters<typeof warmRecord>[0] = {},
) => {
  const record = warmRecord({ operation: capture(), ...overrides });
  s.store.register("profile", record);
  return record;
};

it.each([
  { found: false, emptyCatalog: false },
  { found: true, emptyCatalog: false },
  { found: false, emptyCatalog: true },
])(
  "settles interrupted capture (checkpoint=$found, empty=$emptyCatalog)",
  async ({ found, emptyCatalog }) => {
    const info = vi.fn();
    const s = reconciliation(
      {
        inspect: () =>
          found
            ? jsonResult({ id: leaseId, state: "stopped" })
            : emptyCatalog
              ? failed(`coordinator GET /v1/leases/${leaseId}: http 404: not_found`, 4)
              : absent(),
        list: () =>
          jsonResult(
            emptyCatalog
              ? null
              : [
                  { id: "chk_unrelated", leaseId: `${leaseId}_other`, name: leaseId },
                  ...checkpoints(found ? [candidates[0]!] : []),
                ],
          ),
        delete: () => {
          expect(s.store.lookup("profile")?.operation?.type).toBe("capture");
          return undefined;
        },
      },
      info,
    );
    const image = warmImage("chk_validated", { lastDemandAtMs: Date.now() });
    register(s, {
      ...(found ? { image } : {}),
      allocations: { [leaseId]: warmAllocation() },
    });
    await s.provider.maintain!(context());

    expect(s.store.lookup("profile")).toEqual(found ? warmRecord({ image }) : undefined);
    expect(candidateIds(s)).toEqual(found ? [candidates[0]] : []);
    expect(s.warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(found ? candidates[0]! : "no checkpoint found"),
    );
  },
);

it.each(["released", "expired"])("retries reconciliation once the source is %s", async (state) => {
  let sourceState = "running";
  const s = reconciliation({
    inspect: () => jsonResult({ id: leaseId, provider: "aws", state: sourceState }),
    list: () => jsonResult(checkpoints([candidates[0]!])),
    delete: () => {
      expect(s.store.lookup("profile")?.operation?.type).toBe("capture");
      return undefined;
    },
  });
  const record = register(s);
  await s.provider.maintain!(context());

  expect(s.store.lookup("profile")).toEqual(record);
  expect(s.calls.every(({ argv }) => argv[1] === "inspect")).toBe(true);
  expect(s.warn).toHaveBeenCalledOnce();

  sourceState = state;
  await s.provider.maintain!(context());

  expect(s.store.lookup("profile")).toBeUndefined();
  expect(candidateIds(s)).toEqual([candidates[0]]);
  expect(s.warn).toHaveBeenCalledOnce();
});

it.each([
  "ambiguous",
  "lookup",
  "shape",
  "identity",
  "alive",
  "deleting",
  "failed",
  "cleanup",
  "archived",
  "inspection",
  "deletion",
  "unclaimed",
  "terminal",
] as const)("retains interrupted capture after %s failure", async (failure) => {
  const unconfirmed = ["alive", "deleting", "failed", "cleanup", "archived"].includes(failure);
  const s = reconciliation({
    inspect: () =>
      failure === "unclaimed"
        ? failed(`${leaseId} is not claimed by Crabbox`, 4)
        : failure === "terminal"
          ? failed("DigitalOcean fixed lease is terminal", 4)
          : unconfirmed
            ? jsonResult({ id: leaseId, state: failure === "alive" ? "running" : failure })
            : failure === "inspection"
              ? failed("fixture inspection failed")
              : absent(),
    list: () =>
      failure === "lookup"
        ? failed("fixture catalog unavailable")
        : jsonResult(
            failure === "shape"
              ? {}
              : failure === "identity"
                ? [{ id: "chk_untracked", name: leaseId }]
                : checkpoints(failure === "ambiguous" ? candidates : [candidates[0]!]),
          ),
    delete: () => failed("fixture deletion failed"),
  });
  const record = register(s, {
    operation: { ...capture(), provider: failure === "terminal" ? "digitalocean" : "aws" },
  });
  await s.provider.maintain!(context());

  const ids = failure === "ambiguous" ? candidates : failure === "deletion" ? [candidates[0]!] : [];
  expect((await s.summary())?.capture).toMatchObject({
    selector: "interrupted",
    phase: "uncertain",
  });
  if (ids.length) {
    expect((await s.summary())?.capture).toMatchObject({ checkpointIds: ids });
    for (const id of ids) {
      expect(s.warn.mock.calls[0]?.[0]).toContain(id);
    }
  } else {
    expect(s.store.lookup("profile")).toEqual(record);
  }
  expect(s.warn).toHaveBeenCalledOnce();
  expect(s.warn.mock.calls[0]?.[0]).toContain("--recover interrupted");
  expect(s.checkpoints("delete")).toHaveLength(failure === "deletion" ? 1 : 0);
  if (unconfirmed || ["inspection", "unclaimed", "terminal"].includes(failure)) {
    expect(s.checkpoints("list")).toHaveLength(0);
  }
});

it("preserves earlier candidates when another catalog fails", async () => {
  const s = scenario(({ argv }) => {
    if (argv[1] === "inspect") {
      return absent();
    }
    return argv[0] === "/opt/a/crabbox"
      ? jsonResult(checkpoints([candidates[0]!]))
      : failed("second catalog unavailable");
  });
  register(s, { operation: { ...capture(), checkpointIds: candidates } });
  await s.provider.maintain!({
    ...context(),
    profiles: [
      { ...PROFILE, binary: "/opt/a/crabbox" },
      { ...PROFILE, binary: "/opt/b/crabbox" },
    ],
  });

  expect((await s.summary())?.capture).toMatchObject({
    phase: "uncertain",
    checkpointIds: candidates,
  });
  expect(s.warn.mock.calls[0]?.[0]).toContain("second catalog unavailable");
  expect(s.checkpoints("delete")).toHaveLength(0);
});

it.each(["image", "previous", "allocation"] as const)(
  "preserves checkpoints owned by %s",
  async (owner) => {
    const checkpointId = candidates[0]!;
    const s = reconciliation({
      inspect: absent,
      list: () => jsonResult(checkpoints([checkpointId])),
    });
    const record = register(
      s,
      owner === "allocation"
        ? { allocations: { cbx_borrower: warmAllocation({ kind: "checkpoint", checkpointId }) } }
        : { [owner]: warmImage(checkpointId, { pinned: { atMs: 1 } }) },
    );
    await s.provider.maintain!(context());

    expect(s.store.lookup("profile")).toEqual({
      ...record,
      operation: { ...record.operation, checkpointIds: [checkpointId] },
    });
    expect(s.checkpoints("delete")).toHaveLength(0);
    expect(s.warn.mock.calls[0]?.[0]).toContain("already owned");
  },
);

it("rechecks maintenance authority after catalog lookup", async () => {
  let current = true;
  const s = reconciliation({
    inspect: absent,
    list: () => {
      current = false;
      return jsonResult(checkpoints([candidates[0]!]));
    },
  });
  const record = register(s);
  await expect(
    s.provider.maintain!({
      ...context(),
      assertCurrent() {
        if (!current) {
          throw new Error("maintenance authority closed");
        }
      },
    }),
  ).rejects.toThrow("maintenance authority closed");

  expect(s.store.lookup("profile")).toEqual(record);
  expect(s.checkpoints("delete")).toHaveLength(0);
});
