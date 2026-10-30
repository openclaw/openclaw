import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  getSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { buildCodexAppServerRuntimeFingerprint } from "./app-server/plugin-app-cache-key.js";
import {
  bindingStoreKey,
  type StoredCodexAppServerBinding,
} from "./app-server/session-binding-record.js";
import { createCodexAppServerBindingStore } from "./app-server/session-binding.js";
import { createCodexTestBindingStateStore } from "./app-server/session-binding.test-helpers.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import { registerOwnerDmRecovery } from "./owner-dm-recovery.js";

const sessionKey = "agent:main:slack:direct:team:t12345:user:u67890";
const sessionId = "physical-session";
const identity = { kind: "session", agentId: "main", sessionId, sessionKey } as const;
const ownerKey = bindingStoreKey(identity);
const threadId = "interrupted-thread";
const turnId = "interrupted-turn";
const rows = new Map<string, StoredCodexAppServerBinding>();
let session: SessionEntry;
let dir: string;
let storePath: string;
let pluginRuntimeOwnerId: string | undefined;
let config: OpenClawConfig;
let server: WebSocketServer;
let olderStatus: string;
let onNativeRead: (() => void) | undefined;
const calls: string[] = [];
let inspect: Handler;
let reset: Handler;
type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

async function call(handler: Handler, params: Record<string, unknown>) {
  const respond = vi.fn();
  await handler({
    params,
    respond,
    req: { type: "req", id: "1", method: "codex.ownerDmRecovery" },
    client: {
      connect: { scopes: ["operator.admin"] },
      internal: { pluginRuntimeOwnerId },
    } as GatewayRequestHandlerOptions["client"],
    isWebchatConnect: () => false,
    context: { getRuntimeConfig: () => config } as GatewayRequestHandlerOptions["context"],
    hasCurrentClientAuthority: () => true,
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0]!;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-owner-recovery-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  storePath = join(dir, "agents", "main", "sessions", "sessions.json");
  pluginRuntimeOwnerId = "claw-gateway-plugin";
  calls.length = 0;
  rows.clear();
  olderStatus = "completed";
  onNativeRead = undefined;
  session = { sessionId, updatedAt: 10, sessionStartedAt: 3 };
  await upsertSessionEntry({ agentId: "main", sessionKey, storePath, entry: session });
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback port");
  }
  const pluginConfig = {
    appServer: { transport: "websocket", url: `ws://127.0.0.1:${address.port}` },
  };
  config = {
    session: { store: storePath },
    plugins: { entries: { codex: { config: pluginConfig } } },
  };
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  rows.set(ownerKey, {
    version: 1,
    state: "active",
    sessionId,
    binding: {
      cwd: "/fixture",
      threadId,
      turnRecovery: { turnId, state: "settling" },
      appServerRuntimeFingerprint: buildCodexAppServerRuntimeFingerprint({ appServer }),
    },
  });
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      const { id, method, params } = JSON.parse(data.toString());
      calls.push(method);
      if (method === "initialized") {
        return;
      }
      let result: unknown;
      switch (method) {
        case "initialize":
          result = { userAgent: `codex/${CODEX_APP_SERVER_VERSION}` };
          break;
        case "thread/read":
          onNativeRead?.();
          expect(params).toEqual({ threadId, includeTurns: false });
          result = { thread: { id: threadId, status: { type: "notLoaded" } } };
          break;
        case "thread/turns/list":
          expect(params).toMatchObject({ threadId, itemsView: "notLoaded", sortDirection: "asc" });
          result = params.cursor
            ? { data: [{ id: turnId, status: "interrupted" }] }
            : { data: [{ id: "older", status: olderStatus }], nextCursor: "next-page" };
          break;
        default:
          throw new Error(`Unexpected native method: ${method}`);
      }
      socket.send(JSON.stringify({ id, result }));
    }),
  );
  const registerGatewayMethod: OpenClawPluginApi["registerGatewayMethod"] = (
    name,
    handler,
    options,
  ) => {
    expect(options?.scope).toBe("operator.admin");
    if (name === "codex.ownerDmRecovery.inspect") {
      inspect = handler;
    } else if (name === "codex.ownerDmRecovery.reset") {
      reset = handler;
    } else {
      throw new Error("Unexpected method");
    }
  };
  const state = createCodexTestBindingStateStore(rows);
  registerOwnerDmRecovery(
    createTestPluginApi({ id: "codex", registerGatewayMethod }),
    state,
    createCodexAppServerBindingStore(state),
  );
});
afterEach(async () => {
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it("checks only native metadata, resets exactly the inspected generation once, and retains the interrupted task", async () => {
  const [ok, diagnosis] = await call(inspect, { sessionKey });
  expect(ok).toBe(true);
  expect(diagnosis).toEqual({
    state: "interrupted",
    incidentId: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const request = { sessionKey, incidentId: diagnosis.incidentId };
  expect(await call(reset, request)).toEqual([true, { state: "reset" }]);
  expect(await call(reset, request)).toEqual([true, { state: "changed" }]);
  expect(rows.get(ownerKey)?.state).not.toBe("active");
  expect(getSessionEntry({ agentId: "main", storePath, sessionKey })).toMatchObject(session);
  expect(calls.filter((method) => method === "thread/read")).toHaveLength(3);
  expect(new Set(calls)).toEqual(
    new Set(["initialize", "initialized", "thread/read", "thread/turns/list"]),
  );
});

it("refuses a still-active older native turn, a stale generation, or conflicting binding ownership", async () => {
  const [, diagnosis] = await call(inspect, { sessionKey });
  const request = { sessionKey, incidentId: diagnosis.incidentId };
  olderStatus = "inProgress";
  expect(await call(inspect, { sessionKey })).toEqual([true, { state: "busy" }]);
  expect(await call(reset, request)).toEqual([true, { state: "changed" }]);
  olderStatus = "completed";
  await upsertSessionEntry({
    agentId: "main",
    storePath,
    sessionKey,
    entry: { ...session, updatedAt: 12 },
  });
  expect(await call(reset, request)).toEqual([true, { state: "changed" }]);
  rows.set("conversation:other", rows.get(ownerKey)!);
  expect(await call(inspect, { sessionKey })).toEqual([true, { state: "unavailable" }]);
  expect(rows.get(ownerKey)?.state).toBe("active");
});
it("rejects a non-owner-DM route before accessing the session or native app-server", async () => {
  const [ok, , error] = await call(inspect, { sessionKey: "agent:main:slack:channel:c123" });
  expect(ok).toBe(false);
  expect(error.code).toBe("INVALID_REQUEST");
  pluginRuntimeOwnerId = "unrelated-bundled-plugin";
  const [permitted] = await call(inspect, { sessionKey });
  expect(permitted).toBe(false);
  expect(calls).toEqual([]);
});

it("refuses a physical-only binding when two logical Slack DMs share its host session ID", async () => {
  const otherKey = "agent:main:slack:direct:team:t12345:user:u11111";
  await upsertSessionEntry({ agentId: "main", sessionKey: otherKey, storePath, entry: session });
  const [, observed] = await call(inspect, { sessionKey });
  const physicalKey = bindingStoreKey({ kind: "session", agentId: "main", sessionId });
  rows.set(physicalKey, rows.get(ownerKey)!);
  rows.delete(ownerKey);
  for (const key of [sessionKey, otherKey]) {
    expect(await call(inspect, { sessionKey: key })).toEqual([true, { state: "unavailable" }]);
    const [accepted] = await call(reset, { sessionKey: key, incidentId: observed.incidentId });
    expect(accepted).toBe(false);
  }
  expect(rows.get(physicalKey)?.state).toBe("active");
});

it("preserves a different receipt installed on the same host generation before the binding commit", async () => {
  const [, observed] = await call(inspect, { sessionKey });
  onNativeRead = () => {
    const row = rows.get(ownerKey);
    if (!row || row.state !== "active") {
      throw new Error("Missing live binding");
    }
    rows.set(ownerKey, {
      ...row,
      binding: { ...row.binding, turnRecovery: { turnId: "replacement-turn", state: "accepted" } },
    });
  };
  expect(await call(reset, { sessionKey, incidentId: observed.incidentId })).toEqual([
    true,
    { state: "changed" },
  ]);
  expect(rows.get(ownerKey)).toMatchObject({
    state: "active",
    binding: { turnRecovery: { turnId: "replacement-turn" } },
  });
});
