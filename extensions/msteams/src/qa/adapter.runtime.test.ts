import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createMSTeamsQaTransportAdapter } from "./adapter.runtime.js";

const sleep = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: sleep,
}));

const createdDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function listenOnLoopback(server: Server): Promise<number> {
  onTestFinished(async () => {
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback server address");
  }
  return address.port;
}

async function prepareAdapterFlow(
  adapter: Awaited<ReturnType<typeof createMSTeamsQaTransportAdapter>>,
  gatewayBaseUrl: string,
  outputDir: string,
) {
  await adapter.prepareFlow?.({
    config: {},
    scenarioId: "channel-canary",
    scenarioTitle: "Channel transport canary",
    gateway: {
      baseUrl: gatewayBaseUrl,
      tempRoot: outputDir,
      workspaceDir: outputDir,
      runtimeEnv: {},
      call: vi.fn(),
    },
    outputDir,
    timeoutMs: 1_000,
    waitForConfigRestartSettle: vi.fn(),
  });
}

describe("Microsoft Teams QA transport adapter", () => {
  it("sends ready ingress to the prepared Gateway, not the Lab origin, and cleans up", async () => {
    // openclaw-temp-dir: allow extension tests cannot import repo-only test helpers; afterEach removes it.
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-qa-"));
    createdDirs.push(outputDir);
    const addInboundMessage = vi.fn(async (input) => ({
      ...input,
      id: "bus-inbound-1",
      direction: "inbound",
      timestamp: Date.now(),
    }));
    const addOutboundMessage = vi.fn(async (input) => ({
      ...input,
      id: "bus-outbound-1",
      direction: "outbound",
      timestamp: Date.now(),
    }));
    let labRequests = 0;
    const lab = createServer((_request, response) => {
      labRequests += 1;
      response.writeHead(404).end();
    });
    const labPort = await listenOnLoopback(lab);
    let inboundActivity: Record<string, unknown> | undefined;
    let inboundAuthorization: string | undefined;
    let inboundPath: string | undefined;
    const webhook = createServer((request, response) => {
      inboundAuthorization = request.headers.authorization;
      inboundPath = request.url;
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        inboundActivity = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(202).end();
      })();
    });
    const webhookPort = await listenOnLoopback(webhook);
    const adapter = await createMSTeamsQaTransportAdapter({
      adapterOptions: { transportPolicy: { requireGroupMention: true } },
      channelId: "msteams",
      credentials: {} as never,
      driver: "live",
      messages: {
        addInboundMessage,
        addOutboundMessage,
        editMessage: vi.fn(),
      },
      outputDir,
    });

    let bootstrapPath: string;
    try {
      const env = adapter.createRuntimeEnvPatch?.();
      expect(env?.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
      expect(env).not.toHaveProperty("OPENCLAW_QA_MSTEAMS_CONNECTOR_URL");
      const [bootstrapUrl] = adapter.createRuntimePreloads?.() ?? [];
      expect(bootstrapUrl).toMatch(/^file:/u);
      expect(env?.NODE_OPTIONS).toContain(`--import=${bootstrapUrl}`);
      bootstrapPath = fileURLToPath(bootstrapUrl!);
      const bootstrap = await fs.readFile(bootstrapPath, "utf8");
      expect(bootstrap).toContain('Symbol.for("openclaw.msteams.privateQaRuntime")');
      expect(bootstrap).toContain("http://127.0.0.1:");
      const bootstrapConfig = JSON.parse(
        /globalThis\[key\] = (.+);$/mu.exec(bootstrap)?.[1] ?? "{}",
      ) as { connectorUrl?: string; nonce?: string; botToken?: string };
      expect(bootstrapConfig).toMatchObject({
        connectorUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/u),
        nonce: expect.any(String),
        botToken: expect.any(String),
      });
      expect(bootstrapConfig.botToken?.split(".")).toHaveLength(3);

      const config = adapter.createGatewayConfig({ baseUrl: `http://127.0.0.1:${labPort}` });
      expect(config.channels?.msteams?.webhook).toEqual({ path: "/api/messages" });
      expect(config.channels?.msteams?.legacyWebhook).toBe(false);
      expect(config.channels?.msteams).toMatchObject({
        dmPolicy: "allowlist",
        allowFrom: ["00000000-0000-4000-8000-000000000002"],
      });
      const ready = {
        accountId: "default",
        running: true,
        connected: true,
        lifecycle: "ready",
        restartPending: false,
      };
      const statuses = [
        { ...ready, lifecycle: "starting", connected: false },
        // A new task can retain its predecessor's connected flag until it publishes readiness.
        { ...ready, lifecycle: "starting" },
        { ...ready, connected: false },
        { ...ready, restartPending: true },
        ready,
      ];
      const call = vi.fn().mockRejectedValue(new Error("unexpected extra readiness poll"));
      for (const status of statuses) {
        call.mockResolvedValueOnce({ channelAccounts: { msteams: [status] } });
      }
      await adapter.waitReady({ gateway: { call } });
      expect(call).toHaveBeenCalledTimes(statuses.length);
      expect(inboundActivity).toBeUndefined();
      await prepareAdapterFlow(adapter, `http://127.0.0.1:${webhookPort}`, outputDir);

      await adapter.sendInbound({
        accountId: "default",
        conversation: { id: "qa-primary", kind: "channel" },
        senderId: "driver",
        senderName: "Driver",
        text: "@openclaw qa ingress",
        threadId: "thread-root",
        replyToId: "quoted-parent",
      });
      expect(labRequests).toBe(0);
      expect(inboundPath).toBe("/api/messages");
      expect(inboundAuthorization).toBe(`Bearer ${bootstrapConfig.botToken}`);
      expect(inboundActivity).toMatchObject({
        text: "<at>openclaw</at> qa ingress",
        entities: [
          {
            type: "mention",
            text: "<at>openclaw</at>",
            mentioned: { id: "qa-msteams-app", name: "OpenClaw QA" },
          },
        ],
        serviceUrl: "https://smba.trafficmanager.net/qa",
        replyToId: "quoted-parent",
        from: {
          id: "qa-msteams-driver",
          aadObjectId: "00000000-0000-4000-8000-000000000002",
        },
        conversation: {
          id: "19:qa-primary@thread.tacv2;messageid=thread-root",
          conversationType: "channel",
        },
        channelData: {
          team: { id: "qa-msteams-team" },
          channel: { id: "19:qa-primary@thread.tacv2" },
        },
      });
      expect(addInboundMessage).toHaveBeenCalledTimes(1);
      expect(config.channels?.msteams?.requireMention).toBe(true);

      const outboundResponse = await fetch(
        `${bootstrapConfig.connectorUrl}qa/v3/conversations/${encodeURIComponent(
          "19:qa-primary@thread.tacv2;messageid=thread-root",
        )}/activities`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bootstrapConfig.botToken}`,
            "content-type": "application/json",
            "x-openclaw-msteams-qa-nonce": bootstrapConfig.nonce!,
          },
          body: JSON.stringify({ type: "message", text: "qa outbound" }),
        },
      );
      expect(outboundResponse.status).toBe(200);
      expect(addOutboundMessage).toHaveBeenCalledWith({
        accountId: "default",
        senderId: "qa-msteams-app",
        text: "qa outbound",
        threadId: "thread-root",
        timestamp: expect.any(Number),
        to: "channel:qa-primary",
      });

      for (const [kind, conversationType] of [
        ["direct", "personal"],
        ["group", "groupChat"],
      ] as const) {
        await adapter.sendInbound({
          accountId: "default",
          conversation: { id: `qa-${kind}`, kind },
          senderId: "driver",
          text: "qa chat ingress",
        });
        expect(inboundActivity).toMatchObject({ conversation: { conversationType } });
        // Team/channel markers make a personal chat fail the Gateway's scope admission.
        expect(inboundActivity?.channelData).toEqual({ tenant: { id: "qa-msteams-tenant" } });
      }
      expect(labRequests).toBe(0);
    } finally {
      await adapter.cleanup?.();
    }
    await expect(fs.access(bootstrapPath)).rejects.toThrow();
  });

  it("does not follow webhook redirects to another loopback origin", async () => {
    // openclaw-temp-dir: allow extension tests cannot import repo-only test helpers; afterEach removes it.
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-qa-"));
    createdDirs.push(outputDir);
    const addInboundMessage = vi.fn();
    let redirectedRequests = 0;
    const redirectTarget = createServer((_request, response) => {
      redirectedRequests += 1;
      response.writeHead(200).end();
    });
    const targetPort = await listenOnLoopback(redirectTarget);
    const webhook = createServer((_request, response) => {
      response
        .writeHead(302, {
          location: `http://127.0.0.1:${targetPort}/internal`,
        })
        .end();
    });
    const webhookPort = await listenOnLoopback(webhook);

    const adapter = await createMSTeamsQaTransportAdapter({
      adapterOptions: {},
      channelId: "msteams",
      credentials: {} as never,
      driver: "live",
      messages: {
        addInboundMessage,
        addOutboundMessage: vi.fn(),
        editMessage: vi.fn(),
      },
      outputDir,
    });

    try {
      const config = adapter.createGatewayConfig({ baseUrl: `http://127.0.0.1:${targetPort}` });
      expect(config.channels?.msteams?.webhook).toEqual({ path: "/api/messages" });
      expect(config.channels?.msteams?.legacyWebhook).toBe(false);
      await prepareAdapterFlow(adapter, `http://127.0.0.1:${webhookPort}`, outputDir);
      await expect(
        adapter.sendInbound({
          accountId: "default",
          conversation: { id: "qa-primary", kind: "channel" },
          senderId: "driver",
          text: "qa ingress",
        }),
      ).rejects.toThrow("Too many redirects (limit: 0)");
      expect(redirectedRequests).toBe(0);
      expect(addInboundMessage).not.toHaveBeenCalled();
    } finally {
      await adapter.cleanup?.();
    }
  });
});
