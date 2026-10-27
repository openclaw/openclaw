import type { AgentSideConnection, SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AcpEventLedger } from "./event-ledger.js";
import { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

const session = { sessionId: "session-1", sessionKey: "agent:main:session-1" };
const update: SessionUpdate = { sessionUpdate: "available_commands_update", availableCommands: [] };
const emission = { ...session, record: true, update };
const emptyReplay = { complete: false, events: [] };
const textUpdate = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

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
  it("advertises Ultra in the thinking command", async () => {
    const sessionUpdate = vi.fn<AgentSideConnection["sessionUpdate"]>(async () => {});
    const { updates } = harness(sessionUpdate);
    await updates.sendAvailableCommands(session, { record: false });
    const publishedUpdate = sessionUpdate.mock.calls[0]?.[0].update;
    const think =
      publishedUpdate?.sessionUpdate === "available_commands_update"
        ? publishedUpdate.availableCommands.find((command) => command.name === "think")
        : undefined;
    expect(think?.description).toContain("off|minimal|low|medium|high|xhigh|adaptive|max|ultra");
  });

  it("joins admitted ledger work and blocks reads and writes after shutdown starts", async () => {
    const reading = createDeferred<{ complete: boolean; events: [] }>();
    const { updates, ledger, sessionUpdate } = harness();
    ledger.readReplay.mockReturnValueOnce(reading.promise);
    const replay = updates.readLedgerReplay(session);
    const stopped = vi.fn();
    const closing = updates.stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    reading.resolve({ complete: true, events: [] });
    await replay;
    await closing;
    ledger.readReplay.mockClear();
    await updates.startLedgerSession({ ...session, cwd: "/tmp" }, { complete: true });
    await updates.recordUserPrompt(session, "run-1", []);
    await updates.emit(emission);
    expect(
      await Promise.all([
        updates.readLedgerReplay(session),
        updates.readLedgerReplayBySessionId(session.sessionId),
        updates.readLedgerReplayBySessionKey(session.sessionKey),
      ]),
    ).toEqual([emptyReplay, emptyReplay, emptyReplay]);
    expect(sessionUpdate).not.toHaveBeenCalled();
    for (const method of Object.values(ledger)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])(
    "isolates session queues and drains them independently of delivery on shutdown (first write fails: %s)",
    async (firstFails) => {
      const writing = createDeferred();
      const release = createDeferred();
      const delivery = createDeferred();
      const { updates, ledger } = harness(
        vi.fn().mockReturnValueOnce(delivery.promise).mockResolvedValue(undefined),
      );
      const firstUpdate = textUpdate("first");
      const secondUpdate = textUpdate("second");
      ledger.recordUpdate.mockImplementationOnce(async () => {
        writing.resolve();
        await release.promise;
        if (firstFails) {
          throw new Error("ledger write failed during shutdown");
        }
      });
      const first = updates.emit({ ...emission, update: firstUpdate });
      await writing.promise;
      const second = updates.emit({ ...emission, update: secondUpdate, waitForDelivery: false });
      await updates.emit({
        ...emission,
        sessionId: "session-2",
        sessionKey: "agent:main:session-2",
      });
      expect(ledger.recordUpdate.mock.calls.map(([params]) => params.sessionId)).toEqual([
        "session-1",
        "session-2",
      ]);
      const stopped = vi.fn();
      const closing = updates.stop().then(stopped);
      try {
        await Promise.resolve();
        expect(stopped).not.toHaveBeenCalled();
        release.resolve();
        await second;
        expect(
          ledger.recordUpdate.mock.calls.map(([params]) => [params.sessionId, params.update]),
        ).toEqual([
          [session.sessionId, firstUpdate],
          ["session-2", update],
          [session.sessionId, secondUpdate],
        ]);
        expect(ledger.markIncomplete.mock.calls).toEqual(firstFails ? [[session]] : []);
        await expect(Promise.race([first, Promise.resolve("pending")])).resolves.toBe("pending");
        expect(stopped).not.toHaveBeenCalled();
        delivery.resolve();
        await Promise.all([first, closing]);
      } finally {
        release.resolve();
        delivery.resolve();
        await Promise.allSettled([first, second, closing]);
      }
    },
  );
});
