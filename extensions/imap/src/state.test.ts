import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { resolveImapConfig } from "./config.js";
import { createImapTestRuntime } from "./imap-test-support.js";
import { countImapSkip, initializeImapCursor, rememberImapMessage } from "./state.js";

describe("IMAP cursor initialization", () => {
  const previous = { uidValidity: "1", lastSeenUid: 42, updatedAt: 123 };

  it.each([undefined, null, Number.NaN, Infinity, -1, 0.5, "42", 4294967296])(
    "preserves the old cursor when the baseline is invalid: %s",
    async (baseline) => {
      const { state } = createImapTestRuntime();
      await state.cursors.register("account", previous);
      const register = vi.spyOn(state.cursors, "register");
      // Deliberately inject malformed external data across the typed resolver boundary.
      const resolveBaseline = vi.fn(async () => baseline as number);

      await expect(
        initializeImapCursor(state, "account", "2", resolveBaseline, () => true),
      ).rejects.toThrow(/baseline UID/);
      expect(register).not.toHaveBeenCalled();
      expect(await state.cursors.lookup("account")).toEqual(previous);
    },
  );

  it.each(["", "0", "01", "-1", "1.5", "1e2", " 1"])(
    "rejects invalid UIDVALIDITY before accessing state: %s",
    async (uidValidity) => {
      const { state } = createImapTestRuntime();
      const lookup = vi.spyOn(state.cursors, "lookup");
      const register = vi.spyOn(state.cursors, "register");
      const resolveBaseline = vi.fn(async () => 0);

      await expect(
        initializeImapCursor(state, "account", uidValidity, resolveBaseline, () => true),
      ).rejects.toThrow(/UIDVALIDITY/);
      expect(lookup).not.toHaveBeenCalled();
      expect(resolveBaseline).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, Number.NaN, Infinity, -1, 0.5, "42", 4294967296])(
    "rejects an invalid persisted cursor with matching UIDVALIDITY: %s",
    async (lastSeenUid) => {
      const { state } = createImapTestRuntime();
      const corruptCursor = { ...previous, lastSeenUid: lastSeenUid as number };
      await state.cursors.register("account", corruptCursor);
      const register = vi.spyOn(state.cursors, "register");
      const resolveBaseline = vi.fn(async () => 0);

      await expect(
        initializeImapCursor(state, "account", "1", resolveBaseline, () => true),
      ).rejects.toThrow(/cursor UID/);
      expect(resolveBaseline).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(await state.cursors.lookup("account")).toEqual(corruptCursor);
    },
  );

  it.each(["resolver", "write"])("preserves the old cursor when %s fails", async (failure) => {
    const { state } = createImapTestRuntime();
    await state.cursors.register("account", previous);
    const error = new Error(`${failure} failed`);
    const register = vi.spyOn(state.cursors, "register");
    const resolveBaseline = vi.fn(async () => 99);
    if (failure === "resolver") {
      resolveBaseline.mockRejectedValueOnce(error);
    } else {
      register.mockRejectedValueOnce(error);
    }

    await expect(
      initializeImapCursor(state, "account", "2", resolveBaseline, () => true),
    ).rejects.toBe(error);
    expect(register).toHaveBeenCalledTimes(failure === "resolver" ? 0 : 1);
    expect(await state.cursors.lookup("account")).toEqual(previous);
  });

  it.each([
    { pending: "lookup", reason: "stopped" },
    { pending: "lookup", reason: "replaced" },
    { pending: "resolver", reason: "stopped" },
    { pending: "resolver", reason: "replaced" },
  ])("does not write when $reason while awaiting $pending", async ({ pending, reason }) => {
    const { state } = createImapTestRuntime();
    await state.cursors.register("account", previous);
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const register = vi.spyOn(state.cursors, "register");
    const resolveBaseline = vi.fn(async () => {
      if (pending === "resolver") {
        entered.resolve();
        await released.promise;
      }
      return 99;
    });
    if (pending === "lookup") {
      vi.spyOn(state.cursors, "lookup").mockImplementationOnce(async () => {
        entered.resolve();
        await released.promise;
        return previous;
      });
    }
    const connection = {};
    let currentConnection = connection;
    let stopped = false;
    const operation = initializeImapCursor(
      state,
      "account",
      "2",
      resolveBaseline,
      () => !stopped && currentConnection === connection,
    );
    await entered.promise;
    if (reason === "stopped") {
      stopped = true;
    } else {
      currentConnection = {};
    }
    released.resolve();

    expect(await operation).toBeUndefined();
    expect(resolveBaseline).toHaveBeenCalledTimes(pending === "lookup" ? 0 : 1);
    expect(register).not.toHaveBeenCalled();
    expect(await state.cursors.lookup("account")).toEqual(previous);
  });
});

describe("IMAP durable watcher state", () => {
  it("keeps healthy accounts available when a sibling SecretRef could not resolve", () => {
    const config = resolveImapConfig({
      accounts: {
        healthy: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: "resolved-password",
          agentId: "mail_reader",
        },
        unavailable: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: { source: "env", provider: "default", id: "MISSING_IMAP_PASSWORD" },
          agentId: "mail_reader",
        },
      },
    });
    expect(Object.keys(config.accounts)).toEqual(["healthy"]);
  });

  it("deduplicates logical Message-IDs without growing the account ring", async () => {
    const { state } = createImapTestRuntime();
    for (let index = 0; index < 101; index++) {
      expect(await rememberImapMessage(state, "account", `<${index}@example.com>`)).toBe(true);
    }
    expect(await rememberImapMessage(state, "account", "<100@example.com>")).toBe(false);
    expect((await state.messageIds.lookup("account"))?.messageIds).toHaveLength(100);
  });

  it("increments final account skip counters", async () => {
    const { state } = createImapTestRuntime();
    await countImapSkip(state, "account", "temperror");
    await countImapSkip(state, "account", "temperror");
    expect(await state.skips.lookup("account:temperror")).toEqual({ count: 2 });
  });
});
