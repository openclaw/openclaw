import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClickClackAccount } from "../accounts.js";
import { createClickClackClient } from "../http-client.js";
import { handleClickClackInbound } from "../inbound.js";
import { createInboundMessage, createInboundRuntime } from "../inbound.test-support.js";
import { setClickClackRuntime } from "../runtime.js";
import type { ClickClackChannel, ClickClackMessage, CoreConfig } from "../types.js";
import { discussionChannel, MANAGED_CONTRACT_FIELDS } from "./service-test-support.js";
import { ClickClackDiscussionService } from "./service.js";

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startMockClickClack() {
  const patches: Record<string, unknown>[] = [];
  const messages: ClickClackMessage[] = [];
  const channels: ClickClackChannel[] = [
    discussionChannel({
      id: "chn_general",
      route_id: "general-route",
      name: "general",
      ...MANAGED_CONTRACT_FIELDS,
    }),
  ];
  let createCount = 0;
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers.authorization !== "Bearer proof-token") {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      return sendJson(res, 200, {
        workspaces: [
          {
            id: "wsp_team",
            route_id: "team-route",
            slug: "team",
            name: "Team",
          },
        ],
      });
    }
    if (req.method === "GET" && url.pathname === "/api/workspaces/wsp_team/channels") {
      return sendJson(res, 200, { channels });
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces/wsp_team/channels") {
      createCount += 1;
      const input = await readJson(req);
      const channel = discussionChannel({
        ...input,
        id: "chn_durable",
        route_id: "durable-route",
        archived: false,
        archived_at: null,
      });
      channels.push(channel);
      return sendJson(res, 200, { channel });
    }
    if (req.method === "PATCH" && url.pathname === "/api/channels/chn_durable") {
      const patch = await readJson(req);
      patches.push(patch);
      Object.assign(channels[1]!, patch);
      return sendJson(res, 200, { channel: channels[1] });
    }
    if (req.method === "GET" && url.pathname === "/api/channels/chn_durable/messages") {
      return sendJson(res, 200, { messages, oldest_seq: 1, has_older: false });
    }
    sendJson(res, 404, { error: `unexpected ${req.method} ${url.pathname}` });
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      sendJson(res, 500, { error: "mock ClickClack request failed" });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    channels,
    messages,
    patches,
    get createCount() {
      return createCount;
    },
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("ClickClack durable room real-behavior proof", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  });

  it("keeps one remote room and delivers inbound after archive, reset, deletion, and recreation", async () => {
    const remote = await startMockClickClack();
    cleanups.push(remote.close);
    const sessionKey = "agent:research:proof-room";
    let sessionEntry:
      | { sessionId: string; label: string; updatedAt: number; archivedAt?: number }
      | undefined = {
      sessionId: "session-original",
      label: "Durable proof room",
      updatedAt: 1,
    };
    const config = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: remote.baseUrl,
          token: "proof-token",
          workspace: "team",
          discussions: { enabled: true, workspace: "team", section: "Sessions" },
          allowFrom: ["*"],
        },
      },
    } satisfies CoreConfig;
    const runtime = createInboundRuntime(false);
    vi.mocked(runtime.config.current).mockImplementation(() => config);
    vi.mocked(runtime.agent.session.getSessionEntry).mockImplementation(() => sessionEntry);
    vi.mocked(runtime.agent.session.getSessionEntryAsync).mockImplementation(
      async () => sessionEntry,
    );
    setClickClackRuntime(runtime);
    const service = new ClickClackDiscussionService(runtime, {
      clientFactory: (account) =>
        createClickClackClient({ baseUrl: account.apiEndpoint, token: account.token }),
      installationId: "11111111-2222-4333-8444-555555555555",
      bindingGenerationFactory: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    cleanups.push(async () => service.cleanup());

    await service.open(sessionKey);
    const originalExternalRef = remote.channels[1]?.external_ref;
    remote.messages.push(
      createInboundMessage({
        workspace_id: "wsp_team",
        channel_id: "chn_durable",
        body: "durable history marker",
      }),
    );

    sessionEntry = { ...sessionEntry!, archivedAt: 2 };
    await service.reconcile(sessionKey);
    sessionEntry = { sessionId: "session-reset", label: "Durable proof room", updatedAt: 3 };
    await service.reconcile(sessionKey);
    sessionEntry = undefined;
    await service.reconcile(sessionKey);
    sessionEntry = { sessionId: "session-recreated", label: "Durable proof room", updatedAt: 4 };
    await service.reconcile(sessionKey);

    const history = await service.readLatestMessages(sessionKey, 30);
    await handleClickClackInbound({
      account: resolveClickClackAccount({ cfg: config }),
      config,
      message: {
        ...remote.messages[0]!,
        id: "msg_inbound",
        body: "continue after recreation",
      },
    });

    const managed = remote.channels.filter((channel) => channel.external_managed === true);
    expect(remote.createCount).toBe(1);
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({
      id: "chn_durable",
      external_ref: originalExternalRef,
      archived: false,
      archived_at: null,
    });
    expect(remote.patches.every((patch) => !("archived" in patch))).toBe(true);
    expect(history.text).toContain("durable history marker");
    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledOnce();
  });
});
