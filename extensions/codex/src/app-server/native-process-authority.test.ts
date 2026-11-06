import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import {
  CodexNativeProcessAuthority,
  getCodexNativeProcessClient,
} from "./native-process-authority.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import { createClientHarness } from "./test-support.js";

const cleanups: (() => void)[] = [];
const closes: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  closes.splice(0).forEach((close) => close());
});

function source(sharedClient?: ReturnType<typeof createClientHarness>) {
  const client = sharedClient ?? createClientHarness();
  if (!sharedClient) {
    closes.push(() => client.client.close());
  }
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
  const processes: ReturnType<ReturnType<typeof getCodexNativeProcessClient>["claim"]>[] = [];
  cleanups.push(() => {
    processes.forEach((process) => process.settle());
    owner.release();
  });
  return {
    abort,
    owner,
    released,
    failed,
    client,
    admit(turnId = command.turnId, assert = assertActive) {
      owner.bindTurn(client.client, command.threadId, turnId);
      owner.admit(client.client, { ...command, turnId }, assert);
    },
    claim(stop = async () => {}) {
      const process = getCodexNativeProcessClient(client.client).claim(metadata, stop);
      processes.push(process);
      return process;
    },
  };
}

const command = { threadId: "thread-1", turnId: "turn-1", itemId: "command" };
const assertActive = () => {};
const metadata = { threadId: command.threadId, toolCallId: command.itemId };

describe("native process custody", () => {
  it("rechecks foreground permission before a pending spawn without closing background custody", () => {
    const origin = source();
    let active = true;
    origin.admit(command.turnId, () => {
      if (!active) {
        throw new Error("foreground admission closed");
      }
    });
    const process = origin.claim();
    active = false;
    expect(() => process.assertAdmission()).toThrow("foreground admission closed");
    expect(() => process.assertCurrent()).not.toThrow();
  });

  it("fences a stale or unadmitted turn before accepting a native command", () => {
    const origin = source();
    const { client } = origin;
    expect(() => origin.owner.admit(client.client, command, assertActive)).toThrow("admitted turn");
    origin.owner.bindTurn(client.client, command.threadId, command.turnId);
    expect(() =>
      origin.owner.admit(client.client, { ...command, turnId: "older" }, assertActive),
    ).toThrow("admitted turn");
    expect(() => origin.claim()).toThrow("no admitted native command");
  });

  it("keeps revoked cleanup attached to its concrete resource across client identity reuse", async () => {
    const oldSource = source();
    const newSource = source();
    const stopOld = vi.fn(async () => {});
    const stopNew = vi.fn(async () => {});
    oldSource.admit();
    const oldProcess = oldSource.claim(stopOld);
    newSource.admit();
    const newProcess = newSource.claim(stopNew);
    oldSource.owner.release();
    expect(oldSource.released).not.toHaveBeenCalled();
    oldSource.abort.abort();
    await vi.waitFor(() => expect(stopOld).toHaveBeenCalledOnce());
    expect(stopNew).not.toHaveBeenCalled();
    expect(() => oldProcess.assertCurrent()).toThrow();
    expect(() => newProcess.assertCurrent()).not.toThrow();
    oldProcess.settle();
    expect(oldSource.released).toHaveBeenCalledOnce();
  });

  it("ignores old terminal receipts after an item identity is reused by another turn", () => {
    const earlier = source();
    const { client } = earlier;
    const later = source(client);
    earlier.admit();
    const earlierProcess = earlier.claim();
    earlier.owner.release();
    earlierProcess.settle();
    later.admit("successor");
    client.send(
      itemNotification("item/completed", { id: command.itemId, type: "commandExecution" }),
    );
    client.send(turnCompleted({ id: command.turnId, status: "completed" }));
    const current = later.claim();
    expect(() => current.assertAdmission()).not.toThrow();
    current.settle();
  });

  it("settles each source's admissions only for the selected child turn and physical client", async () => {
    const origin = source();
    const laterSource = source(origin.client);
    const otherClient = createClientHarness();
    closes.push(() => otherClient.client.close());
    const processes = [
      [origin.client.client, "child", "selected"],
      [origin.client.client, "child", "earlier"],
      [origin.client.client, "sibling", "selected"],
      [otherClient.client, "child", "selected"],
      [origin.client.client, "child", "selected"],
    ] as const;
    const stopped = new Set<number>();
    const claims = processes.map(([client, threadId, turnId], index) => {
      const owner = index === 4 ? laterSource.owner : origin.owner;
      owner.bindTurn(client, "parent", "parent-turn");
      const itemId = `command-${index}`;
      owner.admit(client, { threadId, turnId, itemId }, assertActive, "parent");
      const claim = getCodexNativeProcessClient(client).claim(
        { threadId, toolCallId: itemId },
        async () => {
          stopped.add(index);
        },
      );
      cleanups.push(() => claim.settle());
      return claim;
    });
    await getCodexNativeProcessClient(origin.client.client).cancelTurn("child", "selected");
    expect([...stopped]).toEqual([0, 4]);
    expect(() => claims[0]!.assertAdmission()).toThrow("admission has ended");
    expect(() => claims[4]!.assertAdmission()).toThrow("admission has ended");
    for (const claim of claims.slice(1, 4)) {
      expect(() => claim.assertAdmission()).not.toThrow();
    }
  });

  it("settles confirmed background custody when Codex closes the thread", () => {
    const origin = source();
    const { client } = origin;
    origin.owner.bindTurn(client.client, command.threadId, command.turnId);
    const retain = origin.owner.prepareBackgroundCommands(
      client.client,
      command,
      new Map([[command.itemId, "process"]]),
    );
    retain(new Map([[command.itemId, "process"]]));
    origin.owner.release();
    expect(origin.released).not.toHaveBeenCalled();
    // Idle unload drops the listener first, so no item/completed reaches this client.
    client.send({ method: "thread/closed", params: { threadId: command.threadId } });
    expect(origin.released).toHaveBeenCalledOnce();
  });

  it("reports failed background settlement and refuses to replace its unsettled command", async () => {
    const origin = source();
    const { client } = origin;
    const successor = source(client);
    origin.admit();
    origin.claim(async () => {
      throw new Error("fixture backend settlement failed");
    });
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
  });
});
