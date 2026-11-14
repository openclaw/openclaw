import fs from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import os from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { createMSTeamsQaTransportAdapter } from "./adapter.runtime.js";

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: vi.fn(async () => undefined),
}));

async function serveLoopback(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  onTestFinished(() => server[Symbol.asyncDispose]());
  const port = await listenOnLoopback(server);
  return `http://127.0.0.1:${port}`;
}

async function createAdapter(requireGroupMention = false) {
  // openclaw-temp-dir: allow extension tests cannot import repo-only helpers; onTestFinished removes it.
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-qa-"));
  onTestFinished(() => fs.rm(outputDir, { recursive: true, force: true }));
  const messageRecorder = (direction: "inbound" | "outbound") =>
    vi.fn(async (input) => ({
      ...input,
      id: `bus-${direction}-1`,
      direction,
      timestamp: Date.now(),
    }));
  const addInboundMessage = messageRecorder("inbound");
  const addOutboundMessage = messageRecorder("outbound");
  const adapter = await createMSTeamsQaTransportAdapter({
    adapterOptions: requireGroupMention ? { transportPolicy: { requireGroupMention: true } } : {},
    channelId: "msteams",
    credentials: {} as never,
    driver: "live",
    messages: { addInboundMessage, addOutboundMessage, editMessage: vi.fn() },
    outputDir,
  });
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => (cleanupPromise ??= adapter.cleanup?.());
  onTestFinished(cleanup);
  const prepare = (baseUrl: string) =>
    adapter.prepareFlow?.({
      config: {},
      scenarioId: "channel-canary",
      scenarioTitle: "Channel transport canary",
      gateway: {
        baseUrl,
        tempRoot: outputDir,
        workspaceDir: outputDir,
        runtimeEnv: {},
        call: vi.fn(),
      },
      outputDir,
      timeoutMs: 1_000,
      waitForConfigRestartSettle: vi.fn(),
    });
  return { adapter, prepare, addInboundMessage, addOutboundMessage, cleanup };
}

const channelMessage = {
  accountId: "default",
  conversation: { id: "qa-primary", kind: "channel" as const },
  senderId: "driver",
  text: "qa ingress",
};

it("sends ready ingress to the prepared Gateway, not the Lab origin, and cleans up", async () => {
  const lab = vi.fn<RequestListener>((_request, response) => response.writeHead(404).end());
  const labUrl = await serveLoopback(lab);
  let inboundActivity: unknown;
  let inboundAuthorization: string | undefined;
  let inboundPath: string | undefined;
  const webhookUrl = await serveLoopback((request, response) => {
    inboundAuthorization = request.headers.authorization;
    inboundPath = request.url;
    void (async () => {
      inboundActivity = await json(request);
      response.writeHead(202).end();
    })();
  });
  const { adapter, prepare, addInboundMessage, addOutboundMessage, cleanup } =
    await createAdapter(true);
  const env = adapter.createRuntimeEnvPatch?.();
  expect(env?.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
  expect(env).not.toHaveProperty("OPENCLAW_QA_MSTEAMS_CONNECTOR_URL");
  const [bootstrapUrl] = adapter.createRuntimePreloads?.() ?? [];
  expect(env?.NODE_OPTIONS).toContain(`--import=${bootstrapUrl}`);
  const bootstrapPath = fileURLToPath(bootstrapUrl!);
  const bootstrap = await fs.readFile(bootstrapPath, "utf8");
  expect(bootstrap).toContain('Symbol.for("openclaw.msteams.privateQaRuntime")');
  const bootstrapConfig = JSON.parse(
    /globalThis\[key\] = (.+);$/mu.exec(bootstrap)?.[1] ?? "{}",
  ) as { connectorUrl?: string; nonce?: string; botToken?: string };
  expect(bootstrapConfig.connectorUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
  expect(bootstrapConfig.botToken?.split(".")).toHaveLength(3);

  const config = adapter.createGatewayConfig({ baseUrl: labUrl });
  expect(config.channels?.msteams?.webhook).toEqual({ path: "/api/messages" });
  expect(config.channels?.msteams).toMatchObject({
    legacyWebhook: false,
    requireMention: true,
    dmPolicy: "allowlist",
    allowFrom: ["00000000-0000-4000-8000-000000000002"],
  });
  const ready = { accountId: "default", running: true, connected: true, lifecycle: "ready" };
  const statuses = [
    // A new task can retain its predecessor's connected flag until it publishes readiness.
    { ...ready, lifecycle: "starting" },
    { ...ready, connected: false },
    { ...ready, restartPending: true },
    { ...ready, restartPending: false },
  ];
  const call = vi.fn().mockRejectedValue(new Error("unexpected extra readiness poll"));
  for (const status of statuses) {
    call.mockResolvedValueOnce({ channelAccounts: { msteams: [status] } });
  }
  await adapter.waitReady({ gateway: { call } });
  expect(call).toHaveBeenCalledTimes(statuses.length);
  expect(inboundActivity).toBeUndefined();
  await prepare(webhookUrl);

  await adapter.sendInbound({
    ...channelMessage,
    text: "@openclaw qa ingress",
    threadId: "thread-root",
    replyToId: "quoted-parent",
  });
  expect(inboundPath).toBe("/api/messages");
  expect(inboundAuthorization).toBe(`Bearer ${bootstrapConfig.botToken}`);
  const nativeThread = "19:qa-primary@thread.tacv2;messageid=thread-root";
  const mention = "<at>openclaw</at>";
  const mentioned = { id: "qa-msteams-app", name: "OpenClaw QA" };
  expect(inboundActivity).toMatchObject({
    text: `${mention} qa ingress`,
    entities: [{ type: "mention", text: mention, mentioned }],
    serviceUrl: "https://smba.trafficmanager.net/qa",
    replyToId: "quoted-parent",
    from: { id: "qa-msteams-driver", aadObjectId: "00000000-0000-4000-8000-000000000002" },
    conversation: { id: nativeThread, conversationType: "channel" },
    channelData: {
      team: { id: "qa-msteams-team" },
      channel: { id: "19:qa-primary@thread.tacv2" },
    },
  });
  expect(addInboundMessage).toHaveBeenCalledTimes(1);

  const outboundResponse = await fetch(
    `${bootstrapConfig.connectorUrl}qa/v3/conversations/${encodeURIComponent(nativeThread)}/activities`,
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
      ...channelMessage,
      conversation: { id: `qa-${kind}`, kind },
    });
    expect(inboundActivity).toMatchObject({ conversation: { conversationType } });
    // Team/channel markers make a personal chat fail the Gateway's scope admission.
    expect(inboundActivity).toHaveProperty("channelData", { tenant: { id: "qa-msteams-tenant" } });
  }
  expect(lab).not.toHaveBeenCalled();
  await cleanup();
  await expect(fs.access(bootstrapPath)).rejects.toThrow();
});

it("does not follow webhook redirects to another loopback origin", async () => {
  const redirectTarget = vi.fn<RequestListener>((_request, response) =>
    response.writeHead(200).end(),
  );
  const targetUrl = await serveLoopback(redirectTarget);
  const webhookUrl = await serveLoopback((_request, response) => {
    response.writeHead(302, { location: `${targetUrl}/internal` }).end();
  });
  const { adapter, prepare, addInboundMessage } = await createAdapter();
  const config = adapter.createGatewayConfig({ baseUrl: targetUrl });
  expect(config.channels?.msteams?.requireMention).toBe(false);
  await prepare(webhookUrl);
  await expect(adapter.sendInbound(channelMessage)).rejects.toThrow(
    "Too many redirects (limit: 0)",
  );
  expect(redirectTarget).not.toHaveBeenCalled();
  expect(addInboundMessage).not.toHaveBeenCalled();
});
