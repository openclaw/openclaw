import "./service-http-mock.test-support.js";
import "./session-authority.test-support.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buffer as consumeBuffer } from "node:stream/consumers";
import { expect, it, onTestFinished, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { resolveClickClackAccount } from "../accounts.js";
import { handleClickClackInbound } from "../inbound.js";
import { createInboundMessage, createInboundRuntime } from "../inbound.test-support.js";
import { setClickClackRuntime } from "../runtime.js";
import type { ClickClackChannel, ClickClackMessage, CoreConfig } from "../types.js";
import { discussionChannel, MANAGED_CONTRACT_FIELDS } from "./service-test-support.js";
import { ClickClackDiscussionService } from "./service.js";

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await consumeBuffer(req)).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

it("keeps one remote room and delivers inbound after archive, reset, deletion, and recreation", async () => {
  const patches: Record<string, unknown>[] = [];
  const messages: ClickClackMessage[] = [];
  const historyPage = { messages, oldest_seq: 1, has_older: false };
  const channels: ClickClackChannel[] = [
    discussionChannel({ id: "chn_general", ...MANAGED_CONTRACT_FIELDS }),
  ];
  let createCount = 0;
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers.authorization !== "Bearer proof-token") {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    const routes: Record<string, () => unknown> = {
      "GET /api/workspaces": () => ({
        workspaces: [{ id: "wsp_team", route_id: "team-route", slug: "team", name: "Team" }],
      }),
      "GET /api/workspaces/wsp_team/channels": () => ({ channels }),
      "POST /api/workspaces/wsp_team/channels": async () => {
        createCount += 1;
        const channel = discussionChannel({
          ...(await readJson(req)),
          id: "chn_durable",
          route_id: "durable-route",
          archived: false,
          archived_at: null,
        });
        channels.push(channel);
        return { channel };
      },
      "PATCH /api/channels/chn_durable": async () => {
        const patch = await readJson(req);
        patches.push(patch);
        Object.assign(channels[1]!, patch);
        return { channel: channels[1] };
      },
      "GET /api/channels/chn_durable/messages": () => historyPage,
    };
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      return sendJson(res, 200, await route());
    }
    sendJson(res, 404, { error: `unexpected ${req.method} ${url.pathname}` });
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      sendJson(res, 500, { error: "mock ClickClack request failed" });
    });
  });
  onTestFinished(() => server[Symbol.asyncDispose]());
  const port = await listenOnLoopback(server);
  const sessionKey = "agent:research:proof-room";
  const session = (sessionId: string, updatedAt: number) => ({
    sessionId,
    label: "Durable proof room",
    updatedAt,
  });
  let sessionEntry: (ReturnType<typeof session> & { archivedAt?: number }) | undefined = session(
    "session-original",
    1,
  );
  const config = {
    channels: {
      clickclack: {
        enabled: true,
        baseUrl: `http://127.0.0.1:${port}`,
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
  const service = new ClickClackDiscussionService(runtime);
  onTestFinished(() => service.cleanup());

  await service.open(sessionKey);
  const originalExternalRef = channels[1]?.external_ref;
  messages.push(
    createInboundMessage({
      workspace_id: "wsp_team",
      channel_id: "chn_durable",
      body: "durable history marker",
    }),
  );

  sessionEntry = { ...sessionEntry!, label: "Archived rename ignored", archivedAt: 2 };
  await service.reconcile(sessionKey);
  expect(patches).toHaveLength(0);
  sessionEntry = session("session-reset", 3);
  await service.reconcile(sessionKey);
  sessionEntry = undefined;
  await service.reconcile(sessionKey);
  sessionEntry = session("session-recreated", 4);
  await service.reconcile(sessionKey);

  const history = await service.readLatestMessages(sessionKey, 30);
  await handleClickClackInbound({
    account: resolveClickClackAccount({ cfg: config }),
    config,
    message: {
      ...messages[0]!,
      id: "msg_inbound",
      body: "continue after recreation",
    },
  });

  const managed = channels.filter((channel) => channel.external_managed === true);
  expect(createCount).toBe(1);
  expect(managed).toHaveLength(1);
  expect(managed[0]).toMatchObject({
    id: "chn_durable",
    external_ref: originalExternalRef,
    archived: false,
    archived_at: null,
  });
  expect(patches.every((patch) => !("archived" in patch))).toBe(true);
  expect(history.text).toContain("durable history marker");
  expect(runtime.channel.inbound.dispatch).toHaveBeenCalledOnce();
});
