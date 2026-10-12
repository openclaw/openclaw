import { EventEmitter } from "node:events";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { expect, vi, type Mock } from "vitest";
import { startClickClackGatewayAccount } from "./gateway.js";
import type { ResolvedClickClackAccount } from "./types.js";

export class FakeSocket extends EventEmitter {
  emitErrorOnClose = false;

  close = vi.fn(() => {
    if (this.emitErrorOnClose) {
      this.emit("error", new Error("socket closed while connecting"));
    }
    this.emit("close");
  });
}

export function createGatewayContext(
  abortSignal: AbortSignal,
  options: {
    commandMenu?: boolean;
    replyMode?: "agent" | "model";
  } = {},
): ChannelGatewayContext<ResolvedClickClackAccount> {
  const setStatus = vi.fn();
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    cfg: {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          apiBaseUrl: "http://127.0.0.1:8484",
          token: "test-token",
          workspace: "main",
          reconnectMs: 1,
          ...(options.replyMode ? { replyMode: options.replyMode } : {}),
          ...(options.commandMenu === undefined ? {} : { commandMenu: options.commandMenu }),
        },
      },
    } as ChannelGatewayContext<ResolvedClickClackAccount>["cfg"],
    accountId: "default",
    account: {} as ResolvedClickClackAccount,
    runtime: {} as ChannelGatewayContext<ResolvedClickClackAccount>["runtime"],
    abortSignal,
    log,
    getStatus: () =>
      ({ accountId: "default" }) as ReturnType<
        ChannelGatewayContext<ResolvedClickClackAccount>["getStatus"]
      >,
    setStatus,
  };
}

export function createBacklogEvent(index: number, type = "channel.updated") {
  return {
    id: `evt-${index}`,
    cursor: `cursor-${index}`,
    type,
    workspace_id: "workspace-1",
    channel_id: "chan-1",
    seq: index,
    created_at: "2026-01-01T00:00:00.000Z",
    payload: type === "message.created" ? { message_id: "msg-1", author_id: "human-1" } : undefined,
  };
}

export function emitMessageEvent(
  socket: FakeSocket,
  index: number,
  payload: Record<string, unknown> = {},
) {
  const event = createBacklogEvent(index, "message.created");
  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({ ...event, seq: index + 1, payload: { ...event.payload, ...payload } }),
    ),
  );
}

export function createTestBot() {
  return {
    id: "bot-user",
    display_name: "Bot",
    handle: "bot",
    avatar_url: "",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

export function createTestMessage() {
  return {
    id: "msg-1",
    workspace_id: "workspace-1",
    channel_id: "chan-1",
    author_id: "human-1",
    thread_root_id: "msg-1",
    body: "hello",
    body_format: "markdown",
    created_at: "2026-01-01T00:00:00.000Z",
    author: {
      id: "human-1",
      kind: "human",
      display_name: "Human",
      handle: "human",
      avatar_url: "",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

export function waitForGatewayState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { interval: 1 });
}

export async function startGateway(websocket: Mock, options: { commandMenu?: boolean } = {}) {
  const abort = new AbortController();
  const ctx = createGatewayContext(abort.signal, options);
  const run = startClickClackGatewayAccount(ctx);
  await waitForGatewayState(() => expect(websocket).toHaveBeenCalledTimes(1));
  return { abort, ctx, run };
}
