import type { AgentSideConnection, SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AcpEventLedger } from "./event-ledger.js";
import { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

const session = { sessionId: "session-1", sessionKey: "agent:main:session-1" };
const update: SessionUpdate = { sessionUpdate: "available_commands_update", availableCommands: [] };
const emission = { ...session, record: true, update };

function harness(sessionUpdate: AgentSideConnection["sessionUpdate"] = vi.fn(async () => {})) {
  const ledger = {
    startSession: vi.fn(async () => {}),
    recordUserPrompt: vi.fn(async () => {}),
    recordUpdate: vi.fn<AcpEventLedger["recordUpdate"]>(async () => {}),
    markIncomplete: vi.fn(async () => {}),
    readReplay: vi.fn(async () => ({ complete: true, events: [] })),
    readReplayBySessionId: vi.fn(async () => ({ complete: true, events: [] })),
    readReplayBySessionKey: vi.fn(async () => ({ complete: true, events: [] })),
  } satisfies AcpEventLedger;
  const updates = new AcpTranslatorSessionUpdates({
    connection: { sessionUpdate },
    eventLedger: ledger,
    log: () => {},
  });
  return { updates, ledger, sessionUpdate };
}

describe("AcpTranslatorSessionUpdates", () => {
  it("joins admitted ledger work and blocks reads and writes after shutdown starts", async () => {
    const reading = createDeferred<{ complete: boolean; events: [] }>();
    const { updates, ledger, sessionUpdate } = harness();
    ledger.readReplay.mockReturnValueOnce(reading.promise);
    const replay = updates.readLedgerReplay(session);
    let stopped = false;
    const closing = updates.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    reading.resolve({ complete: true, events: [] });
    await replay;
    await closing;
    ledger.readReplay.mockClear();
    await updates.startLedgerSession({ ...session, cwd: "/tmp" }, { complete: true });
    await updates.recordUserPrompt(session, "run-1", []);
    await updates.emit(emission);
    await expect(updates.readLedgerReplay(session)).resolves.toEqual({
      complete: false,
      events: [],
    });
    await expect(updates.readLedgerReplayBySessionId(session.sessionId)).resolves.toEqual({
      complete: false,
      events: [],
    });
    await expect(updates.readLedgerReplayBySessionKey(session.sessionKey)).resolves.toEqual({
      complete: false,
      events: [],
    });
    expect(sessionUpdate).not.toHaveBeenCalled();
    for (const method of Object.values(ledger)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("preserves ledger order without waiting for ACP delivery", async () => {
    const delivery = createDeferred();
    const recorded = createDeferred();
    const { updates, ledger } = harness(
      vi.fn().mockReturnValueOnce(delivery.promise).mockResolvedValue(undefined),
    );
    ledger.recordUpdate.mockImplementation(async () => {
      recorded.resolve();
    });
    const firstUpdate: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "first" },
    };
    const interruption: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "interrupted" },
    };
    const first = updates.emit({ ...emission, update: firstUpdate });
    await recorded.promise;
    await updates.emit({ ...emission, update: interruption, waitForDelivery: false });
    expect(ledger.recordUpdate.mock.calls.map(([params]) => params.update)).toEqual([
      firstUpdate,
      interruption,
    ]);
    await expect(Promise.race([first, Promise.resolve("pending")])).resolves.toBe("pending");
    delivery.resolve();
    await first;
  });

  it("does not let a stalled ledger session block another session", async () => {
    const write = createDeferred();
    const writing = createDeferred();
    const { updates, ledger } = harness();
    ledger.recordUpdate.mockImplementation(async ({ sessionId }) => {
      if (sessionId === session.sessionId) {
        writing.resolve();
        await write.promise;
      }
    });
    const stalled = updates.emit({ ...emission, waitForDelivery: false });
    await writing.promise;
    const queued = updates.emit({ ...emission, waitForDelivery: false });
    await updates.emit({
      ...emission,
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      waitForDelivery: false,
    });
    expect(ledger.recordUpdate.mock.calls.map(([params]) => params.sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);
    write.resolve();
    await Promise.all([stalled, queued]);
    expect(ledger.recordUpdate.mock.calls.map(([params]) => params.sessionId)).toEqual([
      "session-1",
      "session-2",
      "session-1",
    ]);
  });
});
