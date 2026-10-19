import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getIMessageRuntime } from "../runtime.js";
import {
  IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
  IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
  resolveIMessageCatchupCursorKey,
  type IMessageCatchupCursor,
} from "../state-contract.js";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";
import { runIMessageCatchup } from "./catchup-bridge.js";
import { resolveCatchupConfig } from "./catchup.js";
import type { IMessagePayload } from "./types.js";

type RpcCall = {
  method: string;
  params: unknown;
};

function makeFakeClient(responder: (call: RpcCall) => unknown) {
  const calls: RpcCall[] = [];
  const client = {
    request: async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params });
      return responder({ method, params }) as T;
    },
  };
  return { client, calls };
}

function makeRow(
  id: number,
  chat_id = 1,
  created_at = "2026-05-08T11:55:00Z",
  guid = `g-${id}`,
): Record<string, unknown> {
  return {
    id,
    guid,
    chat_id,
    created_at,
    sender: "+15551234",
    is_from_me: false,
    text: "hello",
    chat_identifier: "+15551234",
    chat_guid: "iMessage;-;+15551234",
    is_group: false,
  };
}

function chat(id: number, last_message_at = "2026-05-08T11:55:00.000Z") {
  return { id, last_message_at };
}

function historyClient(chats: ReturnType<typeof chat>[], history: (chatId: number) => unknown[]) {
  return makeFakeClient(({ method, params }) => {
    if (method === "chats.list") {
      return { chats };
    }
    if (method === "messages.history") {
      return { messages: history((params as { chat_id: number }).chat_id) };
    }
    throw new Error(`unexpected method ${method}`);
  });
}

function seedCatchupCursor(
  accountId: string,
  cursor: Omit<IMessageCatchupCursor, "updatedAt">,
): void {
  getIMessageRuntime()
    .state.openSyncKeyedStore<IMessageCatchupCursor>({
      namespace: IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
      maxEntries: IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
    })
    .register(resolveIMessageCatchupCursorKey(accountId), {
      ...cursor,
      updatedAt: Date.now(),
    });
}

function run(
  client: ReturnType<typeof makeFakeClient>["client"],
  options: Partial<Omit<Parameters<typeof runIMessageCatchup>[0], "client">> = {},
) {
  return runIMessageCatchup({
    client: client as never,
    accountId: "default",
    config: resolveCatchupConfig({ enabled: true, perRunLimit: 50, maxAgeMinutes: 60 }),
    includeAttachments: false,
    dispatchPayload: async () => {},
    ...options,
  });
}

function collectGuids(dispatched: string[]) {
  return async (msg: IMessagePayload) => {
    if (msg.guid) {
      dispatched.push(msg.guid);
    }
  };
}

describe("runIMessageCatchup", () => {
  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    installIMessageStateRuntimeForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
  });

  it("fetches chats then per-chat history and dispatches each row in rowid order", async () => {
    const dispatched: string[] = [];
    const { client, calls } = historyClient([chat(1), chat(2, "2026-05-08T11:50:00.000Z")], (id) =>
      id === 1
        ? [makeRow(102), makeRow(100, 1, "2026-05-08T11:50:00Z")]
        : [makeRow(101, 2, "2026-05-08T11:51:00Z")],
    );

    const summary = await run(client, { dispatchPayload: collectGuids(dispatched) });

    expect(summary).toMatchObject({ querySucceeded: true, fullyCaughtUp: true, replayed: 3 });
    expect(dispatched).toEqual(["g-100", "g-101", "g-102"]);
    expect(calls[0]?.method).toBe("chats.list");
    expect(calls.filter((c) => c.method === "messages.history")).toHaveLength(2);
  });

  it("skips chats whose last_message_at is older than the catchup window", async () => {
    let historyCalls = 0;
    const { client } = historyClient([chat(1), chat(99, "2025-12-01T00:00:00.000Z")], (id) => {
      historyCalls += 1;
      return [makeRow(200, id, "2026-05-08T11:55:00Z", `g-${id}`)];
    });

    const summary = await run(client);

    expect(summary).toMatchObject({ querySucceeded: true, replayed: 1 });
    expect(historyCalls).toBe(1);
  });

  it("does not crash on Date-invalid persisted cursor timestamps", async () => {
    const log = vi.fn();
    seedCatchupCursor("default", {
      lastSeenMs: 8_700_000_000_000_000,
      lastSeenRowid: 10,
    });
    const { client, calls } = makeFakeClient(() => {
      throw new Error("unexpected rpc");
    });

    const summary = await run(client, { runtime: { log } });

    expect(summary.querySucceeded).toBe(false);
    expect(calls).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("imessage catchup: invalid since timestamp"),
    );
  });

  it("returns querySucceeded=false when chats.list throws", async () => {
    const { client } = makeFakeClient(({ method }) => {
      if (method === "chats.list") {
        throw new Error("rpc timeout");
      }
      throw new Error(`unexpected method ${method}`);
    });

    const summary = await run(client, {
      dispatchPayload: async () => {
        throw new Error("dispatch should not be called when fetch fails");
      },
    });

    expect(summary).toMatchObject({ querySucceeded: false, fullyCaughtUp: false, replayed: 0 });
  });

  it("continues across chats when a single messages.history call throws", async () => {
    const dispatched: string[] = [];
    const { client } = historyClient([chat(1), chat(2, "2026-05-08T11:50:00.000Z")], (id) => {
      if (id === 1) {
        throw new Error("permission denied");
      }
      return [makeRow(300, 2, "2026-05-08T11:51:00Z")];
    });

    const summary = await run(client, { dispatchPayload: collectGuids(dispatched) });

    expect(summary).toMatchObject({ querySucceeded: true, fullyCaughtUp: false, replayed: 1 });
    expect(dispatched).toEqual(["g-300"]);
  });

  it("caps cross-chat results at perRunLimit, oldest first", async () => {
    const dispatched: string[] = [];
    const { client } = historyClient([chat(1), chat(2)], (id) =>
      Array.from({ length: 4 }, (_, i) => makeRow(id * 100 + i, id)),
    );

    const summary = await run(client, {
      config: resolveCatchupConfig({ enabled: true, perRunLimit: 5, maxAgeMinutes: 60 }),
      dispatchPayload: collectGuids(dispatched),
    });

    expect(summary).toMatchObject({ fetchedCount: 5, fullyCaughtUp: false, replayed: 5 });
    expect(dispatched).toEqual(["g-100", "g-101", "g-102", "g-103", "g-200"]);
    // #79387: the raw watermark must not skip rows excluded by perRunLimit.
    expect(summary.cursorAfter.lastSeenRowid).toBe(200);
  });

  it("treats a dispatch throw as a failure and holds the cursor", async () => {
    const { client } = historyClient([chat(1)], () => [makeRow(500)]);

    const summary = await run(client, {
      config: resolveCatchupConfig({
        enabled: true,
        perRunLimit: 50,
        maxAgeMinutes: 60,
        maxFailureRetries: 3,
      }),
      dispatchPayload: async () => {
        throw new Error("model unavailable");
      },
    });

    expect(summary).toMatchObject({ failed: 1, replayed: 0 });
    expect(summary.cursorAfter.lastSeenRowid).toBe(499);
  });

  it("emits a high-watermark even when every row fails payload validation", async () => {
    // Invalid payloads still supply raw watermarks, preventing replay stalls.
    const { client } = historyClient([chat(1)], () => [
      {
        id: 999,
        guid: 42, // wrong type
        chat_id: "x", // wrong type
        sender: false, // wrong type
        is_from_me: "no", // wrong type
        text: 7, // wrong type
        created_at: "2026-05-08T11:55:00.000Z",
      },
    ]);

    const summary = await run(client);

    expect(summary).toMatchObject({ querySucceeded: true, replayed: 0, fetchedCount: 0 });
    expect(summary.cursorAfter.lastSeenRowid).toBe(999);
  });

  it("filters rows that fail payload validation", async () => {
    const dispatched: string[] = [];
    const { client } = historyClient([chat(1)], () => [
      // Valid row.
      makeRow(600),
      // Junk row — wrong types — must be dropped silently.
      { id: "not-a-number", guid: 42, chat_id: "x" },
      // Missing guid.
      {
        ...makeRow(601, 1, "2026-05-08T11:55:00Z", ""),
        guid: undefined,
      },
    ]);

    const summary = await run(client, { dispatchPayload: collectGuids(dispatched) });

    expect(summary.replayed).toBe(1);
    expect(dispatched).toEqual(["g-600"]);
  });
});
