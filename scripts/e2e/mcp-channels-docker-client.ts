import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../../src/gateway/protocol/index.ts";
import { rawDataToString } from "../../src/infra/ws.ts";

const ClaudeChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()),
  }),
});

const ClaudePermissionNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel/permission"),
  params: z.object({
    request_id: z.string(),
    behavior: z.enum(["allow", "deny"]),
  }),
});

type ClaudeChannelNotification = z.infer<typeof ClaudeChannelNotificationSchema>["params"];

type GatewayRpcClient = {
  request<T>(method: string, params?: unknown): Promise<T>;
  events: Array<{ event: string; payload: Record<string, unknown> }>;
  close(): Promise<void>;
};

type McpClientHandle = {
  client: Client;
  transport: StdioClientTransport;
  rawMessages: unknown[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function extractTextFromGatewayPayload(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const message = payload?.message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const first = content[0];
  if (!first || typeof first !== "object") {
    return undefined;
  }
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

async function connectGateway(params: { url: string; token: string }): Promise<GatewayRpcClient> {
  const ws = new WebSocket(params.url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("gateway ws open timeout")), 10_000);
    timeout.unref?.();
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  const requestedScopes = ["operator.read", "operator.write", "operator.pairing", "operator.admin"];
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

  ws.on("message", (data) => {
    let frame: unknown;
    try {
      frame = JSON.parse(rawDataToString(data));
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") {
      return;
    }
    const typed = frame as {
      type?: unknown;
      event?: unknown;
      payload?: unknown;
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: { message?: unknown } | null;
    };
    if (typed.type === "event" && typeof typed.event === "string") {
      events.push({
        event: typed.event,
        payload:
          typed.payload && typeof typed.payload === "object"
            ? (typed.payload as Record<string, unknown>)
            : {},
      });
      return;
    }
    if (typed.type !== "res" || typeof typed.id !== "string") {
      return;
    }
    const match = pending.get(typed.id);
    if (!match) {
      return;
    }
    pending.delete(typed.id);
    if (typed.ok === true) {
      match.resolve(typed.result);
      return;
    }
    match.reject(
      new Error(
        typed.error && typeof typed.error.message === "string"
          ? typed.error.message
          : "gateway request failed",
      ),
    );
  });

  ws.once("close", (code, reason) => {
    const error = new Error(`gateway closed (${code}): ${rawDataToString(reason)}`);
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  });

  const connectId = randomUUID();
  ws.send(
    JSON.stringify({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "openclaw-tui",
          displayName: "docker-mcp-channels",
          version: "1.0.0",
          platform: process.platform,
          mode: "ui",
        },
        role: "operator",
        scopes: requestedScopes,
        caps: [],
        auth: { token: params.token },
      },
    }),
  );

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(connectId);
      reject(new Error("gateway connect timeout"));
    }, 10_000);
    timeout.unref?.();
    pending.set(connectId, {
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });
  await new Promise<void>((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("gateway sessions.subscribe timeout"));
    }, 10_000);
    timeout.unref?.();
    pending.set(id, {
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "sessions.subscribe",
        params: {},
      }),
    );
  });

  return {
    request(method, requestParams) {
      const id = randomUUID();
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method,
          params: requestParams ?? {},
        }),
      );
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`gateway request timeout: ${method}`));
        }, 10_000);
        timeout.unref?.();
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value as T);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });
    },
    events,
    async close() {
      if (ws.readyState === WebSocket.CLOSED) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        timeout.unref?.();
        ws.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.close();
      });
    },
  };
}

async function waitFor<T>(
  label: string,
  predicate: () => T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value !== undefined) {
      return value;
    }
    await delay(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function connectMcpClient(params: {
  gatewayUrl: string;
  gatewayToken: string;
}): Promise<McpClientHandle> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [
      "/app/openclaw.mjs",
      "mcp",
      "serve",
      "--url",
      params.gatewayUrl,
      "--token",
      params.gatewayToken,
      "--claude-channel-mode",
      "on",
    ],
    cwd: "/app",
    env: {
      ...process.env,
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
      OPENCLAW_STATE_DIR: "/tmp/openclaw-mcp-client",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(`[openclaw mcp] ${String(chunk)}`);
  });
  const rawMessages: unknown[] = [];
  // The MCP stdio transport here exposes a writable onmessage callback at
  // runtime, not an EventTarget-style addEventListener API.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onmessage = (message) => {
    rawMessages.push(message);
  };

  const client = new Client({ name: "docker-mcp-channels", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, rawMessages };
}

async function maybeApprovePendingBridgePairing(gateway: GatewayRpcClient): Promise<boolean> {
  let pairingState:
    | {
        pending?: Array<{ requestId?: string; role?: string }>;
      }
    | undefined;
  try {
    pairingState = await gateway.request<{
      pending?: Array<{ requestId?: string; role?: string }>;
    }>("device.pair.list", {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("missing scope: operator.pairing")) {
      return false;
    }
    throw error;
  }
  if (!pairingState) {
    return false;
  }
  const pendingRequest = pairingState.pending?.find((entry) => entry.role === "operator");
  if (!pendingRequest?.requestId) {
    return false;
  }
  await gateway.request("device.pair.approve", { requestId: pendingRequest.requestId });
  return true;
}

async function main() {
  const gatewayUrl = process.env.GW_URL?.trim();
  const gatewayToken = process.env.GW_TOKEN?.trim();
  assert(gatewayUrl, "missing GW_URL");
  assert(gatewayToken, "missing GW_TOKEN");

  const gateway = await connectGateway({ url: gatewayUrl, token: gatewayToken });
  let mcpHandle = await connectMcpClient({
    gatewayUrl,
    gatewayToken,
  });
  let mcp = mcpHandle.client;

  try {
    await delay(500);
    if (await maybeApprovePendingBridgePairing(gateway)) {
      await Promise.allSettled([mcp.close(), mcpHandle.transport.close()]);
      mcpHandle = await connectMcpClient({
        gatewayUrl,
        gatewayToken,
      });
      mcp = mcpHandle.client;
    }

    const listed = (await mcp.callTool({
      name: "conversations_list",
      arguments: {},
    })) as {
      structuredContent?: { conversations?: Array<Record<string, unknown>> };
    };
    const conversation = listed.structuredContent?.conversations?.find(
      (entry) => entry.sessionKey === "agent:main:main",
    );
    assert(conversation, "expected seeded conversation in conversations_list");
    assert(conversation.channel === "imessage", "expected seeded channel");
    assert(conversation.to === "+15551234567", "expected seeded target");

    const fetched = (await mcp.callTool({
      name: "conversation_get",
      arguments: { session_key: "agent:main:main" },
    })) as {
      structuredContent?: { conversation?: Record<string, unknown> };
      isError?: boolean;
    };
    assert(!fetched.isError, "conversation_get should succeed");
    assert(
      fetched.structuredContent?.conversation?.sessionKey === "agent:main:main",
      "conversation_get returned wrong session",
    );

    const history = (await mcp.callTool({
      name: "messages_read",
      arguments: { session_key: "agent:main:main", limit: 10 },
    })) as {
      structuredContent?: { messages?: Array<Record<string, unknown>> };
    };
    const messages = history.structuredContent?.messages ?? [];
    assert(messages.length >= 2, "expected seeded transcript messages");
    const attachmentMessage = messages.find((entry) => {
      const raw = entry.__openclaw;
      return raw && typeof raw === "object" && (raw as { id?: unknown }).id === "msg-attachment";
    });
    assert(attachmentMessage, "expected seeded attachment message");

    const attachments = (await mcp.callTool({
      name: "attachments_fetch",
      arguments: { session_key: "agent:main:main", message_id: "msg-attachment" },
    })) as {
      structuredContent?: { attachments?: Array<Record<string, unknown>> };
      isError?: boolean;
    };
    assert(!attachments.isError, "attachments_fetch should succeed");
    assert(
      (attachments.structuredContent?.attachments?.length ?? 0) === 1,
      "expected one seeded attachment",
    );

    const waited = (await Promise.all([
      mcp.callTool({
        name: "events_wait",
        arguments: {
          session_key: "agent:main:main",
          after_cursor: 0,
          timeout_ms: 10_000,
        },
      }) as Promise<{
        structuredContent?: { event?: Record<string, unknown> };
      }>,
      gateway.request("chat.inject", {
        sessionKey: "agent:main:main",
        message: "assistant live event",
      }),
    ]).then(([result]) => result)) as {
      structuredContent?: { event?: Record<string, unknown> };
    };
    const assistantEvent = waited.structuredContent?.event;
    assert(assistantEvent, "expected events_wait result");
    assert(assistantEvent.type === "message", "expected message event");
    assert(assistantEvent.role === "assistant", "expected assistant event role");
    assert(assistantEvent.text === "assistant live event", "expected assistant event text");
    const assistantCursor =
      typeof assistantEvent.cursor === "number" ? assistantEvent.cursor : undefined;
    assert(typeof assistantCursor === "number", "expected assistant event cursor");

    const polled = (await mcp.callTool({
      name: "events_poll",
      arguments: { session_key: "agent:main:main", after_cursor: 0, limit: 10 },
    })) as {
      structuredContent?: { events?: Array<Record<string, unknown>> };
    };
    assert(
      (polled.structuredContent?.events ?? []).some(
        (entry) => entry.text === "assistant live event",
      ),
      "expected assistant event in events_poll",
    );

    const channelMessage = `hello from docker ${randomUUID()}`;
    const userEvent = (await Promise.all([
      mcp.callTool({
        name: "events_wait",
        arguments: {
          session_key: "agent:main:main",
          after_cursor: assistantCursor,
          timeout_ms: 10_000,
        },
      }) as Promise<{
        structuredContent?: { event?: Record<string, unknown> };
      }>,
      gateway.request("chat.send", {
        sessionKey: "agent:main:main",
        message: channelMessage,
        idempotencyKey: randomUUID(),
      }),
    ]).then(([result]) => result)) as {
      structuredContent?: { event?: Record<string, unknown> };
    };
    const rawGatewayUserMessage = await waitFor("raw gateway user session.message", () =>
      gateway.events.find(
        (entry) =>
          entry.event === "session.message" &&
          entry.payload.sessionKey === "agent:main:main" &&
          extractTextFromGatewayPayload(entry.payload) === channelMessage,
      ),
    );
    if (userEvent.structuredContent?.event?.text !== channelMessage) {
      throw new Error(
        `expected user event after chat.send: ${JSON.stringify(
          {
            userEvent: userEvent.structuredContent?.event ?? null,
            rawGatewayUserMessage: rawGatewayUserMessage ?? null,
            recentGatewayEvents: gateway.events.slice(-10).map((entry) => ({
              event: entry.event,
              sessionKey: entry.payload.sessionKey,
              text: extractTextFromGatewayPayload(entry.payload),
            })),
          },
          null,
          2,
        )}`,
      );
    }
    assert(rawGatewayUserMessage, "expected raw gateway session.message after chat.send");
    let helpNotification: ClaudeChannelNotification;
    try {
      helpNotification = await waitFor(
        "Claude channel notification",
        () =>
          mcpHandle.rawMessages
            .map((entry) => ClaudeChannelNotificationSchema.safeParse(entry))
            .find(
              (entry) =>
                entry.success &&
                entry.data.params.meta.session_key === "agent:main:main" &&
                entry.data.params.content === channelMessage,
            )?.data.params,
      );
    } catch (error) {
      throw new Error(
        `timeout waiting for Claude channel notification: ${JSON.stringify(
          {
            rawMessages: mcpHandle.rawMessages.slice(-10),
          },
          null,
          2,
        )}`,
        { cause: error },
      );
    }
    assert(helpNotification.content === channelMessage, "expected Claude channel content");

    await mcp.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "run npm test",
        input_preview: '{"cmd":"npm test"}',
      },
    });

    await gateway.request("chat.send", {
      sessionKey: "agent:main:main",
      message: "yes abcde",
      idempotencyKey: randomUUID(),
    });
    const permission = await waitFor(
      "Claude permission notification",
      () =>
        mcpHandle.rawMessages
          .map((entry) => ClaudePermissionNotificationSchema.safeParse(entry))
          .find((entry) => entry.success && entry.data.params.request_id === "abcde")?.data.params,
    );
    assert(permission.behavior === "allow", "expected allow permission reply");

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          sessionKey: "agent:main:main",
          rawNotifications: mcpHandle.rawMessages.filter(
            (entry) =>
              ClaudeChannelNotificationSchema.safeParse(entry).success ||
              ClaudePermissionNotificationSchema.safeParse(entry).success,
          ).length,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await Promise.allSettled([mcp.close(), mcpHandle.transport.close(), gateway.close()]);
  }
}

await main();
