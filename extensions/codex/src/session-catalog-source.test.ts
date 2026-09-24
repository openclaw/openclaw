import { setImmediate as nextTurn } from "node:timers/promises";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";

const cleanups: Array<() => Promise<void>> = [];
let fixtureId = 0;

function thread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: "thread-1",
    projectId: null,
    name: "Native thread",
    preview: "First user request",
    source: "cli",
    cwd: "/workspace/original",
    updatedAt: 100,
    recencyAt: 100,
    status: { type: "idle" },
    ...overrides,
  };
}

async function fixture() {
  const options: CodexAppServerStartOptions = {
    transport: "websocket",
    command: "codex",
    args: ["app-server"],
    url: `wss://catalog-source-${++fixtureId}.example.test/codex`,
    authToken: "synthetic-catalog-source-token",
    headers: {},
  };
  const inventory = [thread()];
  const a = createClientHarness({
    onWrite(line, send) {
      const request = JSON.parse(line);
      if (request.method === "thread/list") {
        send({ id: request.id, result: { data: inventory } });
      }
    },
  });
  const b = createClientHarness();
  await observeCodexCatalogClient(a.client, { startOptions: options });
  await observeCodexCatalogClient(b.client, { startOptions: options });
  const readNative = vi.fn(async (params: CodexThreadListParams) =>
    projectCodexCatalogPage(
      await a.client.request("thread/list", params, { timeoutMs: 1_000, catalogPreview: true }),
      { sanitize: sanitizeTerminalText },
    ),
  );
  const index = new CodexCatalogIndex({
    homeId: await codexCatalogResidentHomeKey({ startOptions: options }),
    readNative,
    assertCurrent: () => {},
  });
  cleanups.push(async () => {
    a.client.close();
    b.client.close();
    await Promise.all([index.close(), a.client.closeAndWait(), b.client.closeAndWait()]);
  });
  await index.initialize();
  const active = (harness: ReturnType<typeof createClientHarness>, flag: string) =>
    harness.send({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "active", activeFlags: [flag] } },
    });
  return { a, b, index, inventory, readNative, active };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex catalog physical status sources", () => {
  it("fences an older read when a source withdraws before becoming a status witness", async () => {
    const { a, b, index, active } = await fixture();
    const nativeRead = vi.spyOn(b.client, "request");
    active(a, "shared-state");
    b.send({ method: "turn/completed", params: { threadId: "thread-1", turn: {} } });
    const request = JSON.parse(await b.waitForWrite(0));
    expect(request.method).toBe("thread/read");
    b.send({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "notLoaded" } },
    });
    b.send({
      id: request.id,
      result: {
        thread: thread({
          cwd: "/workspace/read-settled",
          status: { type: "active", activeFlags: ["shared-state"] },
        }),
      },
    });
    await nativeRead.mock.results[0]!.value;
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions[0]).toMatchObject({
        cwd: "/workspace/read-settled",
        status: "active",
        activeFlags: ["shared-state"],
      });
    });
    a.client.close();
    const current = (await index.list({})).sessions[0];
    expect(current?.status).toBe("notLoaded");
    expect(current).not.toHaveProperty("activeFlags");
    expect(b.writes).toHaveLength(1);
  });

  it.each(["close", "notLoaded"] as const)(
    "retains an equivalent broadcast after one source reports %s",
    async (withdrawal) => {
      const { a, b, index, active } = await fixture();
      active(a, "shared-broadcast");
      active(b, "shared-broadcast");
      if (withdrawal === "close") {
        b.client.close();
      } else {
        b.send({
          method: "thread/status/changed",
          params: { threadId: "thread-1", status: { type: "notLoaded" } },
        });
      }
      expect((await index.list({})).sessions[0]).toMatchObject({
        status: "active",
        activeFlags: ["shared-broadcast"],
      });
      a.client.close();
      const ended = (await index.list({})).sessions[0];
      expect(ended?.status).toBe("notLoaded");
      expect(ended).not.toHaveProperty("activeFlags");
    },
  );

  it("preserves an active source when an unrelated helper client closes", async () => {
    const { a, b, index, readNative, active } = await fixture();
    active(a, "source-a");
    b.client.close();
    expect((await index.list({})).sessions[0]).toMatchObject({
      status: "active",
      activeFlags: ["source-a"],
    });
    expect(readNative).toHaveBeenCalledOnce();
  });

  it.each(["thread/read", "thread/start", "thread/fork", "thread/resume"] as const)(
    "ignores a buffered %s status after its source closes",
    async (method) => {
      const { a, b, index, active } = await fixture();
      const reading = a.client.request<{ thread: CodexThread }>(
        method,
        method === "thread/start" ? {} : { threadId: "thread-1" },
        { timeoutMs: 1_000 },
      );
      const request = JSON.parse(await a.waitForWrite(1));
      const native = thread({ status: { type: "active", activeFlags: ["stale-source-a"] } });
      a.send({
        id: request.id,
        result: { thread: native },
      });
      a.client.close();
      active(b, "source-b");
      const response = await reading;
      expect(response.thread).toEqual(native);
      await index.upsertThread(response.thread);
      expect((await index.list({})).sessions[0]).toMatchObject({
        status: "active",
        activeFlags: ["source-b"],
      });
      expect(JSON.stringify(index.get("thread-1"))).not.toContain('"closed"');
    },
  );

  it("keeps another source active when a DB-only list reports source-local notLoaded", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const { b, index, inventory, readNative, active } = await fixture();
    active(b, "source-b");
    inventory[0] = thread({ cwd: "/workspace/fresh", status: { type: "notLoaded" } });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await readNative.mock.results[1]!.value;
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions[0]?.cwd).toBe("/workspace/fresh");
    });
    await nextTurn();
    expect((await index.list({})).sessions[0]).toMatchObject({
      status: "active",
      activeFlags: ["source-b"],
    });
    expect(readNative).toHaveBeenCalledTimes(2);
    expect(readNative.mock.calls[1]?.[0]).toMatchObject({ useStateDbOnly: true });
  });
});
