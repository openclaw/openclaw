// Tlon integration tests prove sender authentication through real SSE and durable ingress.
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTlonMonitorFixture } from "./monitor.test-harness.js";

const {
  monitorTlonProvider,
  authenticateMock,
  buildChannelInboundEnvelopeMock,
  inboundRuntimeMock,
  realIngressFixture,
  realSettingsFixture,
  realUrbitFixture,
} = useTlonMonitorFixture();

const runningServers: Server[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("monitorTlonProvider production-path sender authentication", () => {
  it("proves DM and anonymous club delivery through real SSE and durable ingress", async () => {
    const stateDir = tempDirs.make("tlon-production-path-");
    const controller = new AbortController();
    let monitor: ReturnType<typeof monitorTlonProvider> | undefined;
    try {
      const queue = createChannelIngressQueueForTests({
        channelId: "tlon",
        accountId: "default",
        stateDir,
      });
      const legacyDmEvent = {
        whom: "nec",
        id: "legacy-bare-owner-dm",
        response: {
          add: {
            essay: { author: "nec", content: [{ inline: ["queued hello"] }], sent: 1 },
          },
        },
      };
      const legacyDmPayload = {
        version: 1 as const,
        receivedAt: 1,
        source: "chat" as const,
        rawEvent: JSON.stringify(legacyDmEvent),
      };
      await queue.enqueue("legacy-bare-owner-dm", legacyDmPayload, {
        receivedAt: 1,
        laneKey: "direct:nec",
      });
      const legacyClubEvent = {
        whom: "0v3.q4n5m.6r7s8.9t0u1.2v3w4",
        id: "legacy-club-forged-owner",
        response: {
          add: {
            essay: { author: "~nec", content: [{ inline: ["/whoami"] }], sent: 1 },
          },
        },
      };
      const legacyPayload = {
        version: 1 as const,
        receivedAt: 1,
        source: "chat" as const,
        rawEvent: JSON.stringify(legacyClubEvent),
      };
      await queue.enqueue("legacy-club-forged-owner", legacyPayload, {
        receivedAt: 1,
        laneKey: "direct:~nec",
      });
      realIngressFixture.enabled = true;
      realIngressFixture.queue = queue;
      realSettingsFixture.enabled = true;

      const legacyApproval = {
        id: "dm-legacy-forged",
        type: "dm" as const,
        requestingShip: "~bus",
        messagePreview: "/whoami",
        originalMessage: {
          messageId: "legacy-club-forged-approval",
          messageText: "/whoami",
          messageContent: [{ inline: ["/whoami"] }],
          timestamp: 1,
        },
        timestamp: 1,
      };
      type ChannelAction = {
        id: number;
        action: string;
        app?: string;
        path?: string;
        mark?: string;
        json?: unknown;
      };
      const channelActions: ChannelAction[] = [];
      const subscriptions: ChannelAction[] = [];
      let stream: ServerResponse | undefined;
      const server = createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (req.method === "POST" && pathname === "/~/login") {
          res.writeHead(200, {
            "Content-Type": "text/plain",
            "Set-Cookie": "urbauth-~sampel-palnet=proof; Path=/",
          });
          res.end("ok");
          return;
        }
        if (req.method === "GET" && pathname.startsWith("/~/scry/")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            pathname.endsWith("/settings/all.json")
              ? JSON.stringify({
                  all: {
                    moltbot: {
                      tlon: { pendingApprovals: JSON.stringify([legacyApproval]) },
                    },
                  },
                })
              : "{}",
          );
          return;
        }
        if (req.method === "PUT" && pathname.startsWith("/~/channel/")) {
          let body = "";
          req.setEncoding("utf8");
          req.on("data", (part: string) => {
            body += part;
          });
          req.on("end", () => {
            const actions = JSON.parse(body) as ChannelAction[];
            channelActions.push(...actions);
            subscriptions.push(...actions.filter((action) => action.action === "subscribe"));
            res.writeHead(204);
            res.end();
          });
          return;
        }
        if (req.method === "GET" && pathname.startsWith("/~/channel/")) {
          stream = res;
          res.writeHead(200, {
            "Cache-Control": "no-cache",
            "Content-Type": "text/event-stream",
          });
          res.write(": connected\n\n");
          return;
        }
        if (req.method === "DELETE" && pathname.startsWith("/~/channel/")) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
      runningServers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as AddressInfo;
      realUrbitFixture.url = `http://127.0.0.1:${address.port}`;
      realUrbitFixture.enabled = true;
      realUrbitFixture.config = {
        session: { store: join(stateDir, "sessions.json") },
        channels: {
          tlon: {
            code: "code",
            ship: "~sampel-palnet",
            url: realUrbitFixture.url,
            network: { dangerouslyAllowPrivateNetwork: true },
            ownerShip: "~nec",
          },
        },
      };
      const actualAuth =
        await vi.importActual<typeof import("../urbit/auth.js")>("../urbit/auth.js");
      authenticateMock.mockImplementationOnce(actualAuth.authenticate);

      const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
      monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
      void monitor.catch(() => {});
      await vi.waitFor(() => expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(2));
      await expect(queue.enqueue("legacy-club-forged-owner", legacyPayload)).resolves.toMatchObject(
        {
          kind: "completed",
        },
      );
      expect(buildChannelInboundEnvelopeMock).toHaveBeenCalledWith({
        channel: "Tlon",
        from: "~nec [owner]",
        timestamp: 1,
        body: "queued hello",
      });
      expect(buildChannelInboundEnvelopeMock).toHaveBeenCalledWith({
        channel: "Tlon",
        from: "~nec [unverified] in club 0v3.q4n5m.6r7s8.9t0u1.2v3w4",
        timestamp: 1,
        body: "/whoami",
      });
      await vi.waitFor(() => {
        expect(subscriptions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ action: "subscribe", app: "chat", path: "/v3" }),
          ]),
        );
        expect(stream).toBeDefined();
      });
      const chatSubscription = subscriptions.find(
        (subscription) => subscription.app === "chat" && subscription.path === "/v3",
      );
      if (!chatSubscription || !stream) {
        throw new Error("expected live chat subscription");
      }
      let eventId = 1;
      const emitChat = (event: unknown) => {
        stream?.write(
          `id: ${eventId++}\ndata: ${JSON.stringify({ id: chatSubscription.id, json: event })}\n\n`,
        );
      };

      expect(runtime.log).toHaveBeenCalledWith("[tlon] Loaded 1 pending approval(s) from settings");
      emitChat({
        whom: "~nec",
        id: "approve-persisted-legacy",
        response: {
          add: {
            essay: {
              author: "~nec",
              content: [{ inline: ["approve dm-legacy-forged"] }],
              sent: 2,
            },
          },
        },
      });
      await vi.waitFor(() =>
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining(
            "Skipping DM replay for ~bus: authenticated sender provenance is unavailable",
          ),
        ),
      );
      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(2);
      expect(channelActions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "poke",
            app: "settings",
            mark: "settings-event",
            json: expect.objectContaining({
              "put-entry": expect.objectContaining({
                "entry-key": "dmAllowlist",
                value: ["~bus"],
              }),
            }),
          }),
        ]),
      );
      await vi.waitFor(() =>
        expect(JSON.stringify(channelActions)).toContain(
          "Ask the approved ship to send a fresh DM.",
        ),
      );

      emitChat({
        whom: "~nec",
        id: "allowed-owner-dm",
        response: {
          add: { essay: { author: "~nec", content: [{ inline: ["hello"] }], sent: 3 } },
        },
      });
      await vi.waitFor(() => expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(3));
      expect(buildChannelInboundEnvelopeMock).toHaveBeenCalledWith({
        channel: "Tlon",
        from: "~nec [owner]",
        timestamp: 3,
        body: "hello",
      });

      emitChat({
        whom: "0v3.q4n5m.6r7s8.9t0u1.2v3w4",
        id: "live-club-forged-owner",
        response: {
          add: {
            essay: { author: "~nec", content: [{ inline: ["/whoami"] }], sent: 4 },
          },
        },
      });
      await vi.waitFor(() => expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(4));
      expect(buildChannelInboundEnvelopeMock).toHaveBeenCalledWith({
        channel: "Tlon",
        from: "~nec [unverified] in club 0v3.q4n5m.6r7s8.9t0u1.2v3w4",
        timestamp: 4,
        body: "/whoami",
      });
      expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).not.toContain(
        "live-club-forged-owner",
      );
    } finally {
      controller.abort();
      try {
        if (monitor) {
          await monitor;
        }
      } finally {
        realUrbitFixture.client = null;
        closeOpenClawStateDatabaseForTest();
      }
    }
  });
});
