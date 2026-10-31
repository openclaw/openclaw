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

type RpcCall = {
  method: string;
  params: unknown;
};

function makeFakeClient(responder: (call: RpcCall) => unknown) {
  return {
    request: vi.fn(
      async <T>(method: string, params: unknown): Promise<T> => responder({ method, params }) as T,
    ),
  };
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

async function run(
  client: ReturnType<typeof makeFakeClient>,
  options: Partial<Omit<Parameters<typeof runIMessageCatchup>[0], "client">> = {},
) {
  const dispatchPayload = vi.fn<Parameters<typeof runIMessageCatchup>[0]["dispatchPayload"]>(
    async () => {},
  );
  const summary = await runIMessageCatchup({
    client: client as never,
    accountId: "default",
    config: resolveCatchupConfig({ enabled: true, perRunLimit: 50, maxAgeMinutes: 60 }),
    includeAttachments: false,
    dispatchPayload,
    ...options,
  });
  return { summary, dispatchPayload, guids: dispatchPayload.mock.calls.map(([msg]) => msg.guid) };
}

async function expectCursorRowid(lastSeenRowid: number, lastSeenMs?: number) {
  const cursor = await getIMessageRuntime()
    .state.openKeyedStoreV2<IMessageCatchupCursor>({
      namespace: IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
      maxEntries: IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
    })
    .lookup(resolveIMessageCatchupCursorKey("default"));
  expect(cursor?.lastSeenRowid).toBe(lastSeenRowid);
  if (lastSeenMs !== undefined) {
    expect(cursor?.lastSeenMs).toBe(lastSeenMs);
  }
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

  it("skips chats whose last_message_at is older than the catchup window", async () => {
    const client = historyClient([chat(1), chat(99, "2025-12-01T00:00:00.000Z")], (id) => [
      makeRow(200, id, "2026-05-08T11:55:00Z", `g-${id}`),
    ]);
    const { summary, guids } = await run(client);
    expect(summary).toMatchObject({ querySucceeded: true, replayed: 1 });
    expect(guids).toEqual(["g-1"]);
  });

  it("does not crash on Date-invalid persisted cursor timestamps", async () => {
    const log = vi.fn();
    seedCatchupCursor("default", {
      lastSeenMs: 8_700_000_000_000_000,
      lastSeenRowid: 10,
    });
    const client = makeFakeClient(() => {
      throw new Error("unexpected rpc");
    });

    const { summary } = await run(client, { runtime: { log } });

    expect(summary.querySucceeded).toBe(false);
    expect(client.request).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("imessage catchup: invalid since timestamp"),
    );
  });

  it("returns querySucceeded=false when chats.list throws", async () => {
    const client = makeFakeClient(() => {
      throw new Error("rpc timeout");
    });
    const { summary, dispatchPayload } = await run(client);
    expect(summary).toMatchObject({ querySucceeded: false, fullyCaughtUp: false, replayed: 0 });
    expect(dispatchPayload).not.toHaveBeenCalled();
  });

  it("continues across chats when a single messages.history call throws", async () => {
    const client = historyClient([chat(1), chat(2, "2026-05-08T11:50:00.000Z")], (id) => {
      if (id === 1) {
        throw new Error("permission denied");
      }
      return [makeRow(300, 2, "2026-05-08T11:51:00Z")];
    });

    const { summary, guids } = await run(client);
    expect(summary).toMatchObject({ querySucceeded: true, fullyCaughtUp: false, replayed: 1 });
    expect(guids).toEqual(["g-300"]);
  });

  it("treats a dispatch throw as a failure and holds the cursor", async () => {
    const client = historyClient([chat(1)], () => [makeRow(500)]);

    const { summary } = await run(client, {
      dispatchPayload: async () => {
        throw new Error("model unavailable");
      },
    });

    expect(summary).toMatchObject({ failed: 1, replayed: 0 });
    await expectCursorRowid(499);
  });

  it("reports incomplete catchup when the cross-chat cap truncates results", async () => {
    const client = historyClient([chat(1), chat(2)], (id) =>
      Array.from({ length: 4 }, (_, i) => makeRow(id * 100 + i, id)),
    );
    const { summary } = await run(client, {
      config: resolveCatchupConfig({ enabled: true, perRunLimit: 5, maxAgeMinutes: 60 }),
    });
    expect(summary).toMatchObject({ fetchedCount: 5, fullyCaughtUp: false, replayed: 5 });
  });

  it("emits a high-watermark even when every row fails payload validation", async () => {
    const client = historyClient([chat(1)], () => [{ ...makeRow(999), guid: 42 }]);
    const { summary, dispatchPayload } = await run(client);
    expect(summary).toMatchObject({ querySucceeded: true, replayed: 0, fetchedCount: 0 });
    expect(dispatchPayload).not.toHaveBeenCalled();
    await expectCursorRowid(999, Date.parse("2026-05-08T11:55:00.000Z"));
  });

  it("filters rows that fail payload validation", async () => {
    const client = historyClient([chat(1)], () => [
      makeRow(600),
      { id: "not-a-number", guid: 42, chat_id: "x" },
      { ...makeRow(601), guid: undefined },
    ]);

    const { summary, guids } = await run(client);
    expect(summary.replayed).toBe(1);
    expect(guids).toEqual(["g-600"]);
  });
});
