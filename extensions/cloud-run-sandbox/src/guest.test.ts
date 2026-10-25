import { describe, expect, it, vi } from "vitest";
import { GuestOwner, type GuestJournal, type GuestRecord } from "./guest.js";
import type { Invoke } from "./native.js";

const runtimeId = "oc-cr-00000000-0000-4000-8000-000000000001";
const config = { rootfs: "/opt/guest", allowEgress: false, guestLifetimeSeconds: 60 };
const ok = () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
function fixture(run: Invoke = async () => ok()) {
  const rows = new Map<string, GuestRecord>();
  const journal: GuestJournal = {
    register: vi.fn(async (key, value, options) => {
      options?.assertCurrent?.();
      rows.set(key, structuredClone(value));
    }),
    delete: vi.fn(async (key) => rows.delete(key)),
    entries: vi.fn(async () =>
      [...rows].map(([key, value]) => ({ key, value, createdAt: 0, updatedAt: 0 })),
    ),
  };
  return { rows, journal, owner: new GuestOwner(journal, run) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Cloud Run guest ownership", () => {
  it("journals before allocation and deletes only its named guest", async () => {
    const run = vi.fn<Invoke>(async (args) => {
      if (args[0] === "run") {
        expect(rows.has(args[1] ?? "")).toBe(true);
      }
      return ok();
    });
    const { owner, rows } = fixture(run);
    const guest = owner.guest(runtimeId, () => {});
    await guest.create(config, config.rootfs, []);
    expect(run.mock.calls[0]?.[0]).toEqual([
      "run",
      guest.record.guestId,
      "--detach",
      "--rootfs=/opt/guest",
      "--write",
      "--",
      "/bin/sleep",
      "60",
    ]);
    await guest.close();
    expect(run.mock.calls.at(-1)?.[0]).toEqual(["delete", "--force", guest.record.guestId]);
    expect(rows.size).toBe(0);
    await guest.close();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("does not allocate after revocation during journal admission", async () => {
    let current = true;
    const run = vi.fn<Invoke>(async () => ok());
    const { owner, journal } = fixture(run);
    journal.register = vi.fn(async () => {
      current = false;
    });
    const guest = owner.guest(runtimeId, () => {
      if (!current) {
        throw new Error("revoked");
      }
    });
    await expect(guest.create(config, config.rootfs, [])).rejects.toThrow("revoked");
    expect(run).not.toHaveBeenCalled();
  });
  it("waits for creation before deleting on cancellation", async () => {
    const entered = deferred();
    const release = deferred();
    const run = vi.fn<Invoke>(async (args) => {
      if (args[0] === "run") {
        entered.resolve();
        await release.promise;
      }
      return ok();
    });
    const { owner, rows } = fixture(run);
    const guest = owner.guest(runtimeId, () => {});
    const created = guest.create(config, config.rootfs, []).catch((error: unknown) => error);
    await entered.promise;
    const closed = guest.close();
    expect(run).toHaveBeenCalledTimes(1);
    release.resolve();
    await closed;
    expect(await created).toBeInstanceOf(Error);
    expect(rows.size).toBe(0);
    expect(() => guest.execSpec(["/bin/true"])).toThrow("ended");
  });
  it("retains uncertain creation receipts even when delete returns success", async () => {
    const run = vi.fn<Invoke>(async (args) =>
      args[0] === "run" ? { ...ok(), code: 1, stderr: Buffer.from("transport timeout") } : ok(),
    );
    const { owner, rows } = fixture(run);
    const guest = owner.guest(runtimeId, () => {});
    await expect(guest.create(config, config.rootfs, [])).rejects.toThrow(
      "creation and cleanup failed",
    );
    expect(rows.get(guest.record.guestId)?.phase).toBe("creating");
  });
  it("retains failed deletes and permits an exact retry", async () => {
    let fail = true;
    const run: Invoke = async (args) =>
      args[0] === "delete" && fail
        ? { ...ok(), code: 1, stderr: Buffer.from("unavailable") }
        : ok();
    const { owner, rows } = fixture(run);
    const guest = owner.guest(runtimeId, () => {});
    await guest.create(config, config.rootfs, []);
    await expect(guest.close()).rejects.toThrow("delete failed");
    expect(rows.size).toBe(1);
    fail = false;
    await guest.close();
    expect(rows.size).toBe(0);
  });
  it("termination authority survives execution revocation without running guest code", async () => {
    let current = true;
    const run = vi.fn<Invoke>(async () => ok());
    const { owner } = fixture(run);
    const guest = owner.guest(runtimeId, () => {
      if (!current) {
        throw new Error("revoked");
      }
    });
    await guest.create(config, config.rootfs, []);
    current = false;
    expect(() => guest.execSpec(["/bin/true"])).toThrow("revoked");
    await guest.close();
    expect(run.mock.calls.map(([args]) => args[0])).toEqual(["run", "delete"]);
  });
  it("does not cancel a concurrent sibling guest", async () => {
    const run = vi.fn<Invoke>(async () => ok());
    const { owner } = fixture(run);
    const a = owner.guest(runtimeId, () => {});
    const b = owner.guest(runtimeId, () => {});
    await Promise.all([a.create(config, config.rootfs, []), b.create(config, config.rootfs, [])]);
    await a.close();
    expect(b.execSpec(["/bin/true"]).argv).toContain(b.record.guestId);
    expect(
      run.mock.calls.filter(([args]) => args[0] === "delete").map(([args]) => args[2]),
    ).toEqual([a.record.guestId]);
    await b.close();
  });
  it("recovers acknowledged orphan names before a new allocation", async () => {
    const run = vi.fn<Invoke>(async () => ok());
    const { owner, rows } = fixture(run);
    const stale = "oc-exec-00000000-0000-4000-8000-000000000002";
    rows.set(stale, { runtimeId, guestId: stale, phase: "ready" });
    await owner.recover();
    expect(run.mock.calls[0]?.[0]).toEqual(["delete", "--force", stale]);
    expect(rows.size).toBe(0);
  });
  it("fails closed on invalid persisted ownership", async () => {
    const run = vi.fn<Invoke>(async () => ok());
    const { owner, rows } = fixture(run);
    rows.set("arbitrary", { runtimeId, guestId: "somebody-elses-sandbox", phase: "ready" });
    await expect(owner.recover()).rejects.toThrow("Invalid");
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects execution after plugin shutdown", async () => {
    const { owner } = fixture();
    const guest = owner.guest(runtimeId, () => {});
    await guest.create(config, config.rootfs, []);
    await owner.stop();
    expect(() => guest.execSpec(["/bin/true"])).toThrow("stopping");
  });
  it("continues retiring siblings after an uncertain creation cannot settle", async () => {
    let failCreate = true;
    const run = vi.fn<Invoke>(async (args) =>
      args[0] === "run" && failCreate ? { ...ok(), code: 1 } : ok(),
    );
    const { owner, rows } = fixture(run);
    const a = owner.guest(runtimeId, () => {});
    await expect(a.create(config, config.rootfs, [])).rejects.toThrow();
    failCreate = false;
    const b = owner.guest(runtimeId, () => {});
    await b.create(config, config.rootfs, []);
    await expect(owner.removeRuntime(runtimeId)).rejects.toThrow("incomplete");
    expect(rows.has(a.record.guestId)).toBe(true);
    expect(rows.has(b.record.guestId)).toBe(false);
    expect(
      run.mock.calls.some(([args]) => args[0] === "delete" && args[2] === b.record.guestId),
    ).toBe(true);
  });
  it("recovers later orphans even if an earlier receipt remains unsettled", async () => {
    const run = vi.fn<Invoke>(async () => ok());
    const { owner, rows } = fixture(run);
    const a = "oc-exec-00000000-0000-4000-8000-000000000002";
    const b = "oc-exec-00000000-0000-4000-8000-000000000003";
    rows.set(a, { runtimeId, guestId: a, phase: "creating" });
    rows.set(b, { runtimeId, guestId: b, phase: "ready" });
    await expect(owner.recover()).rejects.toThrow("Unsettled");
    expect(rows.has(a)).toBe(true);
    expect(rows.has(b)).toBe(false);
    expect(run.mock.calls.map(([args]) => args[2])).toEqual([a, b]);
  });
});
