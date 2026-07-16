import { createDurableInboundReceiveJournalFromQueue } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTMAIL_DURABLE_COMPLETED_TTL_MS,
  AGENTMAIL_DURABLE_PENDING_MAX_ENTRIES,
  AGENTMAIL_DURABLE_PENDING_TTL_MS,
  createAgentMailDurableInboundId,
} from "./durable-receive.js";
import {
  AgentMailIngressCapacityError,
  processAgentMailIngress,
  replayPendingAgentMailIngress,
} from "./ingress.js";
import type { AgentMailIngressRecord } from "./types.js";

const record: AgentMailIngressRecord = {
  accountId: "default",
  inboxId: "inbox_1",
  messageId: "message_1",
  transport: "webhook",
  receivedAt: 1,
};

describe("AgentMail durable ingress", () => {
  it("deduplicates the same message across transports", () => {
    expect(createAgentMailDurableInboundId(record)).toBe(
      createAgentMailDurableInboundId({
        accountId: record.accountId,
        inboxId: record.inboxId,
        messageId: record.messageId,
      }),
    );
  });

  it("normalizes generic durable capacity for transport backpressure", async () => {
    const journal = createDurableInboundReceiveJournalFromQueue({
      queue: {
        prune: vi.fn(async () => undefined),
        enqueue: vi.fn(async () => ({ kind: "capacity", maxPendingEntries: 1 })),
      } as never,
      admission: { pendingMaxEntries: 1 },
    });
    await expect(
      processAgentMailIngress({
        journal: journal as never,
        record,
        dispatch: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(AgentMailIngressCapacityError);
  });

  it("dispatches identical webhook and WebSocket deliveries only once", async () => {
    const id = createAgentMailDurableInboundId(record);
    let state: "new" | "pending" | "completed" = "new";
    const dispatch = vi.fn(async () => undefined);
    const journal = {
      accept: vi.fn(async () => {
        if (state === "completed") {
          return { kind: "completed", duplicate: true, record: { id } };
        }
        if (state === "pending") {
          return {
            kind: "pending",
            duplicate: true,
            record: { id, payload: record, attempts: 0 },
          };
        }
        state = "pending";
        return { kind: "accepted", duplicate: false, record: { id } };
      }),
      complete: vi.fn(async () => {
        state = "completed";
      }),
      release: vi.fn(),
    } as never;

    await Promise.all([
      processAgentMailIngress({ journal, record, dispatch }),
      processAgentMailIngress({
        journal,
        record: { ...record, transport: "websocket", eventId: "ws-event" },
        dispatch,
      }),
    ]);
    await vi.waitFor(() => expect(state).toBe("completed"));
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("commits before dispatch and completes only after dispatch", async () => {
    const order: string[] = [];
    const journal = {
      accept: vi.fn(async () => {
        order.push("accept");
        return { kind: "accepted", duplicate: false, record: { id: "durable_1" } };
      }),
      complete: vi.fn(async () => {
        order.push("complete");
      }),
      release: vi.fn(),
    } as never;
    await processAgentMailIngress({
      journal,
      record,
      dispatch: async () => {
        order.push("dispatch");
      },
    });
    await vi.waitFor(() => expect(order).toHaveLength(3));
    expect(order).toEqual(["accept", "dispatch", "complete"]);
  });

  it("returns after durable admission without waiting for agent dispatch", async () => {
    let finishDispatch!: () => void;
    const dispatch = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    const complete = vi.fn(async () => undefined);
    await expect(
      processAgentMailIngress({
        journal: {
          accept: async () => ({ kind: "accepted", duplicate: false, record: {} }),
          complete,
          release: vi.fn(),
        } as never,
        record,
        dispatch,
      }),
    ).resolves.toBe("accepted");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    finishDispatch();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
  });

  it("releases and retries failed background dispatch in-process", async () => {
    const release = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("database busy"))
      .mockResolvedValueOnce(true);
    const complete = vi.fn(async () => undefined);
    const dispatch = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary hydration failure"))
      .mockResolvedValueOnce(undefined);
    await processAgentMailIngress({
      journal: {
        accept: async () => ({ kind: "accepted", duplicate: false, record: {} }),
        complete,
        release,
      } as never,
      record,
      dispatch,
      retryDelayMs: () => 0,
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(release).toHaveBeenCalledWith(createAgentMailDurableInboundId(record), {
      lastError: "temporary hydration failure",
    });
    expect(release).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("keeps accepted ingress retryable beyond the former dispatch budget", async () => {
    const release = vi.fn(async () => true);
    let attempts = 0;
    const dispatch = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 12) {
        throw new Error("temporary dispatch failure");
      }
    });
    const complete = vi.fn(async () => undefined);
    await processAgentMailIngress({
      journal: {
        accept: async () => ({ kind: "accepted", duplicate: false, record: {} }),
        complete,
        release,
      } as never,
      record,
      dispatch,
      retryDelayMs: () => 0,
    });

    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledTimes(13);
    expect(release).toHaveBeenCalledTimes(12);
    expect(release).toHaveBeenLastCalledWith(createAgentMailDurableInboundId(record), {
      lastError: "temporary dispatch failure",
    });
  });

  it("suppresses a terminal failed tombstone without dispatching it as completed work", async () => {
    const dispatch = vi.fn(async () => undefined);
    await expect(
      processAgentMailIngress({
        journal: {
          accept: async () => ({
            kind: "failed",
            duplicate: true,
            record: { id: "durable_1", failedAt: 1, reason: "corrupt_payload" },
          }),
        } as never,
        record,
        dispatch,
      }),
    ).resolves.toBe("duplicate");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retries a failed completion marker without repeating the agent dispatch", async () => {
    const dispatch = vi.fn(async () => undefined);
    const complete = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("database busy"))
      .mockResolvedValueOnce(undefined);
    await processAgentMailIngress({
      journal: {
        accept: async () => ({ kind: "accepted", duplicate: false, record: {} }),
        complete,
        release: vi.fn(),
      } as never,
      record,
      dispatch,
      retryDelayMs: () => 0,
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("completes ingress at turn adoption before agent work can begin", async () => {
    const events: string[] = [];
    const dispatch = vi.fn(
      async (
        _record: AgentMailIngressRecord,
        lifecycle: { onTurnAdopted: () => Promise<void> },
      ) => {
        events.push("recovery-persisted");
        await lifecycle.onTurnAdopted();
        events.push("agent-started");
      },
    );
    const complete = vi.fn(async () => {
      events.push("ingress-complete");
    });
    await processAgentMailIngress({
      journal: {
        accept: async () => ({ kind: "accepted", duplicate: false, record: {} }),
        complete,
        release: vi.fn(),
      } as never,
      record,
      dispatch,
    });
    await vi.waitFor(() => expect(events).toContain("agent-started"));
    expect(events).toEqual(["recovery-persisted", "ingress-complete", "agent-started"]);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not replay a turn after adoption if later dispatch settlement fails", async () => {
    let state: "pending" | "completed" = "pending";
    const release = vi.fn(async () => true);
    const dispatch = vi.fn(
      async (
        _record: AgentMailIngressRecord,
        lifecycle: { onTurnAdopted: () => Promise<void> },
      ) => {
        await lifecycle.onTurnAdopted();
        throw new Error("process exited after agent adoption");
      },
    );
    const journal = {
      accept: vi.fn(async () =>
        state === "completed"
          ? { kind: "completed", duplicate: true, record: { id: "durable_1" } }
          : { kind: "accepted", duplicate: false, record: { id: "durable_1" } },
      ),
      complete: vi.fn(async () => {
        state = "completed";
      }),
      release,
      pending: vi.fn(async () => []),
    } as never;
    await processAgentMailIngress({ journal, record, dispatch });
    await vi.waitFor(() => expect(state).toBe("completed"));
    await replayPendingAgentMailIngress({ journal, dispatch });
    await processAgentMailIngress({ journal, record, dispatch });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("retries journal adoption before starting the agent turn", async () => {
    const complete = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("database busy"))
      .mockResolvedValueOnce(undefined);
    const agentStarted = vi.fn();
    const dispatch = vi.fn(
      async (
        _record: AgentMailIngressRecord,
        lifecycle: { onTurnAdopted: () => Promise<void> },
      ) => {
        await lifecycle.onTurnAdopted();
        agentStarted();
      },
    );
    await processAgentMailIngress({
      journal: {
        accept: async () => ({ kind: "accepted", duplicate: false, record: {} }),
        complete,
        release: vi.fn(async () => true),
      } as never,
      record,
      dispatch,
      retryDelayMs: () => 0,
    });
    await vi.waitFor(() => expect(agentStarted).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("retries only the marker after an irrevocable active-turn adoption", async () => {
    const complete = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("database busy"))
      .mockResolvedValueOnce(undefined);
    const activeTurnCommitted = vi.fn();
    const dispatch = vi.fn(
      async (
        _record: AgentMailIngressRecord,
        lifecycle: { onTurnAdopted: () => Promise<void> },
      ) => {
        // Core cannot unwind an active-turn transcript commit, so it deliberately absorbs an
        // adoption observer failure. Ingress must then retry only its completion marker.
        await lifecycle.onTurnAdopted().catch(() => undefined);
        activeTurnCommitted();
      },
    );
    await processAgentMailIngress({
      journal: {
        accept: async () => ({ kind: "accepted", duplicate: false, record: {} }),
        complete,
        release: vi.fn(),
      } as never,
      record,
      dispatch,
      retryDelayMs: () => 0,
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(activeTurnCommitted).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not redispatch when releasing a failed row reports lost ownership", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("temporary hydration failure");
    });
    const complete = vi.fn();
    await processAgentMailIngress({
      journal: {
        accept: async () => ({ kind: "accepted", duplicate: false, record: {} }),
        complete,
        release: vi.fn(async () => false),
      } as never,
      record,
      dispatch,
      retryDelayMs: () => 0,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it("dispatches a pending record even when no release attempt was recorded", async () => {
    const dispatch = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const pendingRecord = { id: "durable_1", payload: record, attempts: 1 };
    await processAgentMailIngress({
      journal: {
        accept: async () => ({ kind: "pending", duplicate: true, record: pendingRecord }),
        complete,
        release: vi.fn(),
      } as never,
      record: { ...record, transport: "websocket" },
      dispatch,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledWith(
      record,
      expect.objectContaining({ onTurnAdopted: expect.any(Function) }),
    );
    expect(complete).toHaveBeenCalledWith(createAgentMailDurableInboundId(record));

    dispatch.mockClear();
    complete.mockClear();
    await processAgentMailIngress({
      journal: {
        accept: async () => ({
          kind: "pending",
          duplicate: true,
          record: { ...pendingRecord, attempts: 0 },
        }),
        complete,
        release: vi.fn(),
      } as never,
      record,
      dispatch,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(complete).toHaveBeenCalledWith(createAgentMailDurableInboundId(record));
  });

  it("keeps WhatsApp-aligned retention values", () => {
    expect(AGENTMAIL_DURABLE_PENDING_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(AGENTMAIL_DURABLE_COMPLETED_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(AGENTMAIL_DURABLE_PENDING_MAX_ENTRIES).toBe(450);
  });

  it("replays pending records after restart and completes them", async () => {
    const dispatch = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    await replayPendingAgentMailIngress({
      journal: {
        pending: async () => [{ id: "durable_1", payload: record, attempts: 2 }],
        complete,
        release: vi.fn(),
      } as never,
      dispatch,
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("durable_1"));
    expect(dispatch).toHaveBeenCalledWith(
      record,
      expect.objectContaining({ onTurnAdopted: expect.any(Function) }),
    );
  });

  it("hands an in-flight record to a replacement journal without concurrent dispatch", async () => {
    let rejectFirst!: (error: Error) => void;
    const firstDispatch = vi.fn(
      async () =>
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const replacementDispatch = vi.fn(async () => undefined);
    const firstAbort = new AbortController();
    const replacementAbort = new AbortController();
    await processAgentMailIngress({
      journal: {
        accept: async () => ({ kind: "accepted", duplicate: false, record: {} }),
        complete: vi.fn(),
        release: vi.fn(async () => true),
      } as never,
      record,
      dispatch: firstDispatch,
      abortSignal: firstAbort.signal,
      retryDelayMs: () => 0,
    });
    await vi.waitFor(() => expect(firstDispatch).toHaveBeenCalledOnce());

    const replacementComplete = vi.fn(async () => undefined);
    await replayPendingAgentMailIngress({
      journal: {
        pending: async () => [
          { id: createAgentMailDurableInboundId(record), payload: record, attempts: 0 },
        ],
        complete: replacementComplete,
        release: vi.fn(),
      } as never,
      dispatch: replacementDispatch,
      abortSignal: replacementAbort.signal,
      retryDelayMs: () => 0,
    });
    expect(replacementDispatch).not.toHaveBeenCalled();

    firstAbort.abort();
    rejectFirst(new Error("old account stopped"));
    await vi.waitFor(() => expect(replacementComplete).toHaveBeenCalledOnce());
    expect(replacementDispatch).toHaveBeenCalledOnce();
    replacementAbort.abort();
  });

  it("hands a zero-attempt live duplicate to a replacement after a replay race", async () => {
    let rejectFirst!: (error: Error) => void;
    const firstDispatch = vi.fn(
      async () =>
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const firstAbort = new AbortController();
    await processAgentMailIngress({
      journal: {
        accept: async () => ({ kind: "accepted", duplicate: false, record: {} }),
        complete: vi.fn(),
        release: vi.fn(async () => true),
      } as never,
      record,
      dispatch: firstDispatch,
      abortSignal: firstAbort.signal,
      retryDelayMs: () => 0,
    });
    await vi.waitFor(() => expect(firstDispatch).toHaveBeenCalledOnce());

    const replacementDispatch = vi.fn(async () => undefined);
    const replacementComplete = vi.fn(async () => undefined);
    const replacementAbort = new AbortController();
    await processAgentMailIngress({
      journal: {
        accept: async () => ({
          kind: "pending",
          duplicate: true,
          record: {
            id: createAgentMailDurableInboundId(record),
            payload: record,
            attempts: 0,
          },
        }),
        complete: replacementComplete,
        release: vi.fn(),
      } as never,
      record,
      dispatch: replacementDispatch,
      abortSignal: replacementAbort.signal,
      retryDelayMs: () => 0,
    });
    expect(replacementDispatch).not.toHaveBeenCalled();

    firstAbort.abort();
    rejectFirst(new Error("old account stopped"));
    await vi.waitFor(() => expect(replacementDispatch).toHaveBeenCalledOnce());
    expect(replacementComplete).toHaveBeenCalledWith(createAgentMailDurableInboundId(record));
    replacementAbort.abort();
  });
});
