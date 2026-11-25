import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { resolveImapConfig } from "./config.js";
import { createImapTestRuntime } from "./imap-test-support.js";
import { initializeImapCursor } from "./state.js";

describe("IMAP cursor initialization", () => {
  const previous = { uidValidity: "1", lastSeenUid: 42, updatedAt: 123 };
  const invalidUids = [undefined, null, Number.NaN, Infinity, -1, 0.5, "42", 4294967296];
  async function createCursorFixture(cursor = previous) {
    const { state } = createImapTestRuntime();
    await state.cursors.register("account", cursor);
    const register = vi.spyOn(state.cursors, "register");
    const resolveBaseline = vi.fn(async () => 99);
    const initialize = (validity = "2", active = () => true) =>
      initializeImapCursor(state, "account", validity, resolveBaseline, active);
    return { state, register, resolveBaseline, initialize };
  }

  describe.each(["baseline", "cursor"])("invalid %s UID", (source) => {
    it.each(invalidUids)("preserves the cursor for %s", async (uid) => {
      const cursor = source === "cursor" ? { ...previous, lastSeenUid: uid as number } : previous;
      const { state, register, resolveBaseline, initialize } = await createCursorFixture(cursor);
      resolveBaseline.mockResolvedValueOnce(uid as number);
      await expect(initialize(source === "cursor" ? "1" : "2")).rejects.toThrow(`${source} UID`);
      if (source === "cursor") {
        expect(resolveBaseline).not.toHaveBeenCalled();
      }
      expect(register).not.toHaveBeenCalled();
      expect(await state.cursors.lookup("account")).toEqual(cursor);
    });
  });

  it("rejects noncanonical UIDVALIDITY before state access", async () => {
    const { state, register, resolveBaseline, initialize } = await createCursorFixture();
    const lookup = vi.spyOn(state.cursors, "lookup");
    await expect(initialize("01")).rejects.toThrow(/UIDVALIDITY/);
    expect(lookup).not.toHaveBeenCalled();
    expect(resolveBaseline).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it.each(["resolver", "write"])("preserves the old cursor when %s fails", async (failure) => {
    const { state, register, resolveBaseline, initialize } = await createCursorFixture();
    const error = new Error(`${failure} failed`);
    (failure === "resolver" ? resolveBaseline : register).mockRejectedValueOnce(error);

    await expect(initialize()).rejects.toBe(error);
    expect(await state.cursors.lookup("account")).toEqual(previous);
  });

  it.each(["lookup", "resolver"])("does not write after stopping during %s", async (pending) => {
    const { state, register, resolveBaseline, initialize } = await createCursorFixture();
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const hold = async <T>(value: T) => {
      entered.resolve();
      await released.promise;
      return value;
    };
    if (pending === "lookup") {
      vi.spyOn(state.cursors, "lookup").mockImplementationOnce(() => hold(previous));
    } else {
      resolveBaseline.mockImplementationOnce(() => hold(99));
    }
    let stopped = false;
    const operation = initialize("2", () => !stopped);
    await entered.promise;
    stopped = true;
    released.resolve();

    expect(await operation).toBeUndefined();
    expect(resolveBaseline).toHaveBeenCalledTimes(pending === "lookup" ? 0 : 1);
    expect(register).not.toHaveBeenCalled();
    expect(await state.cursors.lookup("account")).toEqual(previous);
  });
});

it("keeps healthy accounts available when a sibling SecretRef could not resolve", () => {
  const account = { host: "imap.example", user: "reader", agentId: "mail" };
  const config = resolveImapConfig({
    accounts: {
      healthy: { ...account, password: "resolved-password" },
      unavailable: {
        ...account,
        password: { source: "env", provider: "default", id: "MISSING_IMAP_PASSWORD" },
      },
    },
  });
  expect(Object.keys(config.accounts)).toEqual(["healthy"]);
});
