import { describe, expect, it, vi } from "vitest";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import {
  CodexNativeProcessAuthority,
  getCodexNativeProcessClient,
} from "./native-process-authority.js";
import { createClientHarness } from "./test-support.js";

function source() {
  const abort = new AbortController();
  const released = vi.fn();
  const failed = vi.fn();
  const owner = new CodexNativeProcessAuthority(
    createCodexTestHostCapabilities({
      retainSourceAuthority: () => ({
        signal: abort.signal,
        assertCurrent: () => abort.signal.throwIfAborted(),
        release: released,
      }),
    }),
    failed,
  );
  return { abort, owner, released, failed };
}

const command = { threadId: "thread", turnId: "turn", itemId: "command" };
const assertActive = () => {};
const metadata = { threadId: command.threadId, toolCallId: command.itemId };

describe("native process custody", () => {
  it("rechecks foreground permission before a pending spawn without closing background custody", () => {
    const client = createClientHarness();
    const origin = source();
    let active = true;
    origin.owner.bindTurn(client.client, command.threadId, command.turnId);
    origin.owner.admit(client.client, command, () => {
      if (!active) {
        throw new Error("foreground admission closed");
      }
    });
    const process = getCodexNativeProcessClient(client.client).claim(metadata, async () => {});
    try {
      active = false;
      expect(() => process.assertAdmission()).toThrow("foreground admission closed");
      expect(() => process.assertCurrent()).not.toThrow();
    } finally {
      process.settle();
      origin.owner.release();
      client.client.close();
    }
  });

  it("fences a stale or unadmitted turn before accepting a native command", () => {
    const client = createClientHarness();
    const origin = source();
    try {
      expect(() => origin.owner.admit(client.client, command, assertActive)).toThrow(
        "admitted turn",
      );
      origin.owner.bindTurn(client.client, command.threadId, command.turnId);
      expect(() =>
        origin.owner.admit(client.client, { ...command, turnId: "older" }, assertActive),
      ).toThrow("admitted turn");
      expect(() =>
        getCodexNativeProcessClient(client.client).claim(metadata, async () => {}),
      ).toThrow("no admitted native command");
    } finally {
      origin.owner.release();
      client.client.close();
    }
  });

  it("keeps revoked cleanup attached to its concrete resource across client identity reuse", async () => {
    const oldClient = createClientHarness();
    const replacement = createClientHarness();
    const oldSource = source();
    const newSource = source();
    const stopOld = vi.fn(async () => {});
    const stopNew = vi.fn(async () => {});
    oldSource.owner.bindTurn(oldClient.client, command.threadId, command.turnId);
    oldSource.owner.admit(oldClient.client, command, assertActive);
    const oldProcess = getCodexNativeProcessClient(oldClient.client).claim(metadata, stopOld);
    newSource.owner.bindTurn(replacement.client, command.threadId, command.turnId);
    newSource.owner.admit(replacement.client, command, assertActive);
    const newProcess = getCodexNativeProcessClient(replacement.client).claim(metadata, stopNew);
    try {
      oldSource.owner.release();
      expect(oldSource.released).not.toHaveBeenCalled();
      oldSource.abort.abort();
      await vi.waitFor(() => expect(stopOld).toHaveBeenCalledOnce());
      expect(stopNew).not.toHaveBeenCalled();
      expect(() => oldProcess.assertCurrent()).toThrow();
      expect(() => newProcess.assertCurrent()).not.toThrow();
      oldProcess.settle();
      expect(oldSource.released).toHaveBeenCalledOnce();
    } finally {
      oldProcess.settle();
      newProcess.settle();
      oldSource.owner.release();
      newSource.owner.release();
      oldClient.client.close();
      replacement.client.close();
    }
  });

  it("ignores old terminal receipts after an item identity is reused by another turn", () => {
    const client = createClientHarness();
    const earlier = source();
    const later = source();
    earlier.owner.bindTurn(client.client, command.threadId, command.turnId);
    earlier.owner.admit(client.client, command, assertActive);
    const earlierProcess = getCodexNativeProcessClient(client.client).claim(
      metadata,
      async () => {},
    );
    earlier.owner.release();
    earlierProcess.settle();
    later.owner.bindTurn(client.client, command.threadId, "successor");
    later.owner.admit(client.client, { ...command, turnId: "successor" }, assertActive);
    try {
      client.send({
        method: "item/completed",
        params: {
          threadId: command.threadId,
          turnId: command.turnId,
          item: { id: command.itemId, type: "commandExecution" },
        },
      });
      client.send({
        method: "turn/completed",
        params: {
          threadId: command.threadId,
          turn: { id: command.turnId, status: "completed", items: [] },
        },
      });
      const current = getCodexNativeProcessClient(client.client).claim(metadata, async () => {});
      expect(() => current.assertAdmission()).not.toThrow();
      current.settle();
    } finally {
      earlier.owner.release();
      later.owner.release();
      client.client.close();
    }
  });

  it("reports failed background settlement and refuses to replace its unsettled command", async () => {
    const client = createClientHarness();
    const origin = source();
    const successor = source();
    origin.owner.bindTurn(client.client, command.threadId, command.turnId);
    origin.owner.admit(client.client, command, assertActive);
    const process = getCodexNativeProcessClient(client.client).claim(metadata, async () => {
      throw new Error("fixture backend settlement failed");
    });
    try {
      origin.owner.release();
      origin.abort.abort();
      await vi.waitFor(() => expect(origin.failed).toHaveBeenCalledOnce());
      expect(origin.failed.mock.calls[0]?.[0]).toMatchObject({
        message: expect.stringContaining("background work remains unsettled"),
        errors: [expect.objectContaining({ message: "fixture backend settlement failed" })],
      });
      expect(origin.released).not.toHaveBeenCalled();
      successor.owner.bindTurn(client.client, command.threadId, "successor");
      expect(() =>
        successor.owner.admit(client.client, { ...command, turnId: "successor" }, assertActive),
      ).toThrow("unsettled native command identity");
    } finally {
      process.settle();
      origin.owner.release();
      successor.owner.release();
      client.client.close();
    }
  });
});
