import { describe, expect, it } from "vitest";
import {
  CODEX_RESET_LEDGER_KEY,
  createCodexResetCreditLedger,
  type CodexResetLedgerStore,
} from "./reset-credit-ledger.js";

type Stored = Awaited<ReturnType<ReturnType<typeof createCodexResetCreditLedger>["inspect"]>>;
function fakeSqliteCas() {
  let value: Stored | undefined;
  let version = 0;
  let failOneCompare = false;
  const store = {
    async observe(key: string) {
      expect(key).toBe(CODEX_RESET_LEDGER_KEY);
      return { value: value ? structuredClone(value) : undefined, comparison: String(version) };
    },
    async compareAndApply(key: string, comparison: string, intent: { value: Stored }) {
      expect(key).toBe(CODEX_RESET_LEDGER_KEY);
      if (failOneCompare || comparison !== String(version)) {
        failOneCompare = false;
        return {
          status: "conflict" as const,
          current: { value, comparison: String(version) },
        };
      }
      value = structuredClone(intent.value);
      version++;
      return { status: "applied" as const };
    },
    async lookup(key: string) {
      expect(key).toBe(CODEX_RESET_LEDGER_KEY);
      return value ? structuredClone(value) : undefined;
    },
    setCorrupted() {
      value = { version: 1, attempts: [{}] } as unknown as Stored;
      version++;
    },
    conflictOnce() {
      failOneCompare = true;
    },
  };
  return store;
}

function factory(
  store: ReturnType<typeof fakeSqliteCas>,
  now: () => number,
  accountId = "account-one",
  generation = "generation-one",
) {
  return createCodexResetCreditLedger({
    store: store as unknown as CodexResetLedgerStore,
    getSubject: async () => ({ accountId, credentialGeneration: generation }),
    now,
  });
}

describe("Codex reset-credit worker-backed SQLite compare-and-apply ledger", () => {
  it("prevents independent callers from minting two keys while one claim is active", async () => {
    const store = fakeSqliteCas();
    const now = () => 1_800_000_000_000;
    const a = factory(store, now);
    const b = factory(store, now);
    const results = await Promise.all([
      a.claim("openai:first", 1),
      b.claim("openai:first", 1),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual(["busy", "owned"]);
    const attempts = (await a.inspect()).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.idempotencyKey).toMatch(/^[\da-f-]{36}$/i);
  });

  it("reclaims the same durable attempt and key after crash or lease expiry", async () => {
    const store = fakeSqliteCas();
    let timestamp = 1_800_000_000_000;
    const now = () => timestamp;
    const a = factory(store, now);
    const claim = await a.claim("openai:first", 1);
    expect(claim.status).toBe("owned");
    timestamp += 100_000;
    const restarted = factory(store, now);
    const again = await restarted.claim("openai:first", 1);
    expect(again).toEqual(claim);
    if (again.status !== "owned" || claim.status !== "owned") {
      return;
    }
    await expect(a.settle("openai:first", claim.attemptId, "restored")).rejects.toThrow(
      /no longer owns/,
    );
    await restarted.settle("openai:first", again.attemptId, "restored");
    expect((await restarted.inspect()).attempts[0]?.status).toBe("restored");
  });

  it("atomically enforces the 24-hour cap even after a successful spend", async () => {
    const store = fakeSqliteCas();
    let timestamp = 1_800_000_000_000;
    const ledger = factory(store, () => timestamp);
    const claim = await ledger.claim("openai:first", 1);
    if (claim.status !== "owned") {
      throw new Error("test expected owned claim");
    }
    await ledger.settle("openai:first", claim.attemptId, "restored");
    expect(await ledger.claim("openai:first", 1)).toEqual({ status: "limit" });
    timestamp += 24 * 60 * 60_000 + 1;
    expect((await ledger.claim("openai:first", 1)).status).toBe("owned");
  });

  it("blocks a second account behind any uncertain consumption", async () => {
    const store = fakeSqliteCas();
    let timestamp = 1_800_000_000_000;
    const now = () => timestamp;
    const first = factory(store, now, "account-one");
    const claim = await first.claim("openai:first", 10);
    if (claim.status !== "owned") {
      throw new Error("test expected owned claim");
    }
    await first.settle("openai:first", claim.attemptId, "uncertain");
    const other = factory(store, now, "account-two");
    expect(await other.claim("openai:second", 10)).toEqual({ status: "uncertain" });
    timestamp += 100_000;
    expect(await first.claim("openai:first", 10)).toEqual(claim);
    expect((await first.inspect()).attempts).toHaveLength(1);
  });

  it("never reuses a key from another credential generation", async () => {
    const store = fakeSqliteCas();
    let timestamp = 1_800_000_000_000;
    const now = () => timestamp;
    const old = factory(store, now);
    expect((await old.claim("openai:first", 1)).status).toBe("owned");
    timestamp += 100_000;
    const rotated = factory(store, now, "account-one", "generation-two");
    expect(await rotated.claim("openai:first", 1)).toEqual({ status: "uncertain" });
  });

  it("lets a bounded waiter join one shared result and supports cancellation", async () => {
    const store = fakeSqliteCas();
    const ledger = factory(store, Date.now);
    const claim = await ledger.claim("openai:first", 1);
    if (claim.status !== "owned") {
      throw new Error("test expected owned claim");
    }
    const joined = ledger.waitForPending({ timeoutMs: 1_000, pollMs: 10 });
    await ledger.settle("openai:first", claim.attemptId, "restored");
    expect(await joined).toBe("settled");
    const controller = new AbortController();
    controller.abort();
    expect(await ledger.waitForPending({
      timeoutMs: 1_000, signal: controller.signal,
    })).toBe("aborted");
  });

  it("refuses corrupted persistent state instead of resetting spent history", async () => {
    const store = fakeSqliteCas();
    store.setCorrupted();
    await expect(factory(store, Date.now).claim("openai:first", 1)).rejects.toThrow(
      /unreadable/,
    );
  });

  it("retries an explicit compare conflict without pretending a failed claim committed", async () => {
    const store = fakeSqliteCas();
    store.conflictOnce();
    const ledger = factory(store, Date.now);
    const claim = await ledger.claim("openai:first", 1);
    expect(claim.status).toBe("owned");
    if (claim.status === "owned") {
      await ledger.settle("openai:first", claim.attemptId, "not-needed");
    }
    expect((await ledger.inspect()).attempts[0]?.status).toBe("not-needed");
  });
});
