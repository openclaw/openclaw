import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClickClackAccount } from "./accounts.js";
import type { ClickClackInboundAccess } from "./access.js";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, CoreConfig } from "./types.js";

const SOURCE_MESSAGE_ID = "msg_01arz3ndektsv4rrffq69g5fav";
const NONCE_CONFLICT = "client nonce was already used for a different message";

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function listenLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
}

describe("ClickClack inbound replay transport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps one visible agent reply after a committed response stalls and the event replays", async () => {
    const visibleMessages = new Map<string, string>();
    const requests: Array<{ body: string; nonce: string; status: number }> = [];
    let resolveFirstCommit: (() => void) | undefined;
    const firstCommit = new Promise<void>((resolve) => {
      resolveFirstCommit = resolve;
    });
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const payload = await readJsonBody(request);
        const body = String(payload.body ?? "");
        const nonce = String(payload.nonce ?? "");
        const existing = visibleMessages.get(nonce);
        if (existing === undefined) {
          visibleMessages.set(nonce, body);
          requests.push({ body, nonce, status: 201 });
          response.writeHead(201, { "Content-Type": "application/json" });
          response.write('{"message":');
          resolveFirstCommit?.();
          return;
        }
        requests.push({ body, nonce, status: 400 });
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: NONCE_CONFLICT }));
      })().catch((error: unknown) => {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
    });
    const port = await listenLoopback(server);
    const apiEndpoint = `http://127.0.0.1:${port}`;
    const config = {
      channels: {
        clickclack: {
          baseUrl: apiEndpoint,
          apiBaseUrl: apiEndpoint,
          token: "redacted-proof-token",
          workspace: "wsp_proof",
        },
      },
    } as CoreConfig;
    const account = resolveClickClackAccount({ cfg: config });
    const message = {
      id: SOURCE_MESSAGE_ID,
      workspace_id: "wsp_proof",
      channel_id: "chn_proof",
      author_id: "usr_proof",
      thread_root_id: SOURCE_MESSAGE_ID,
      body: "run proof",
      body_format: "markdown",
      created_at: "2026-08-07T00:00:00.000Z",
    } satisfies ClickClackMessage;
    const access = {
      shouldDispatch: true,
      commandAuthorized: true,
      mentionFacts: { canDetectMention: true, wasMentioned: true },
      preparedRoute: {
        isDirect: false,
        target: "channel:chn_proof",
        route: {
          agentId: "main",
          channel: "clickclack",
          accountId: "default",
          dmScope: "main",
          sessionKey: "agent:main:clickclack:channel:chn_proof",
          mainSessionKey: "agent:main:main",
          lastRoutePolicy: "session",
          matchedBy: "default",
        },
        revoked: false,
      },
    } satisfies ClickClackInboundAccess;
    const replies = ["first visible reply", "regenerated replay reply"];
    const runtime = createPluginRuntimeMock();
    runtime.channel.inbound.dispatch = vi.fn(
      async (plan: Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0]) => {
        await plan.delivery.deliver({ text: replies.shift() ?? "" }, { kind: "final" });
        return {
          admission: { kind: "dispatch" },
          dispatched: true,
          ctxPayload: plan.ctxPayload,
          routeSessionKey: plan.route.sessionKey,
          dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } },
        };
      },
    ) as unknown as PluginRuntime["channel"]["inbound"]["dispatch"];
    setClickClackRuntime(runtime);

    try {
      vi.useFakeTimers();
      const firstAttempt = handleClickClackInbound({ account, config, message, access });
      await firstCommit;
      await vi.advanceTimersByTimeAsync(30_000);
      await firstAttempt;
      vi.useRealTimers();

      await handleClickClackInbound({ account, config, message, access });

      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.status)).toEqual([201, 400]);
      expect(new Set(requests.map((request) => request.nonce)).size).toBe(1);
      expect(requests.map((request) => request.body)).toEqual([
        "first visible reply",
        "regenerated replay reply",
      ]);
      expect(visibleMessages.size).toBe(1);
      console.info(
        "CLICKCLACK_REPLAY_PROOF",
        JSON.stringify({
          attempts: requests.length,
          statuses: requests.map((request) => request.status),
          uniqueNonces: new Set(requests.map((request) => request.nonce)).size,
          visibleMessages: visibleMessages.size,
          token: "[redacted]",
        }),
      );
    } finally {
      await closeServer(server);
    }
  });
});
