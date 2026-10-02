import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, type Server } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTalkGatewayControlOwnerTestFixture,
  withPluginRuntimeGatewayRequestScope,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  createBroker,
  createRequest,
  createResponseHarness,
} from "./realtime-quicksilver.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const AUDIO_ONLY_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

function resolveNonLoopbackIPv4(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find(
      (candidate) => candidate.family === "IPv4" && !candidate.internal,
    );
    if (address) {
      return address.address;
    }
  }
  throw new Error("Real origin-policy proof requires a non-loopback IPv4 interface");
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listenWebSocket(server: WebSocketServer): Promise<number> {
  if (server.address()) {
    return (server.address() as AddressInfo).port;
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createDeferredOfferRequest(params: { origin: string; token: string }): {
  req: IncomingMessage;
  finish: (body: string) => void;
} {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.headers = {
    authorization: `Bearer ${params.token}`,
    "content-type": "application/sdp",
    origin: params.origin,
  };
  return {
    req,
    finish: (body) => {
      req.push(Buffer.from(body));
      req.complete = true;
      req.push(null);
    },
  };
}

describe("GPT-Live offer origin policy", () => {
  it("enforces final policy over real HTTP and settles the durable voice owner", async () => {
    const cfg: OpenClawConfig = { gateway: { publicOrigin: "https://public.example.test" } };
    let providerRequests = 0;
    const providerServer = createServer((req, res) => {
      providerRequests += 1;
      req.resume();
      req.once("end", () => {
        res.statusCode = 201;
        res.setHeader("Location", "/v1/live/rtc_transport_proof");
        res.end("v=answer\r\n");
      });
    });
    const providerPort = await listen(providerServer);
    const sidebandServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const sidebandPort = await listenWebSocket(sidebandServer);
    let sidebandConnections = 0;
    sidebandServer.on("connection", () => {
      sidebandConnections += 1;
    });
    const { realtime } = createBroker({
      getConfig: () => cfg,
      fetchImpl: (_input, init) =>
        fetch(`http://127.0.0.1:${providerPort}/v1/realtime/calls`, init),
      webSocketFactory: (_url, options) => new WebSocket(`ws://127.0.0.1:${sidebandPort}`, options),
    });
    const gatewayServer = createServer((req, res) => {
      void withPluginRuntimeGatewayRequestScope(
        { isWebchatConnect: () => false, publishedPort: 25432 },
        () => realtime.handler(req, res),
      ).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      });
    });
    const gatewayHost = resolveNonLoopbackIPv4();
    const gatewayPort = await listen(gatewayServer, "0.0.0.0");
    const endpoint = `http://${gatewayHost}:${gatewayPort}/plugins/openai/realtime/calls`;
    const createReservation = async (
      gateway?: ReturnType<typeof createTalkGatewayControlOwnerTestFixture>,
    ) => {
      const session = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-test-canary",
          ...(gateway
            ? {
                clientControl: { owner: "gateway" as const },
                runAgentConsult: gateway.owner.runAgentConsult,
                gatewayControl: gateway.owner.control,
              }
            : { runAgentConsult: vi.fn(async () => ({ text: "Done" })) }),
        },
        { type: "api-key", token: "platform-key" },
      );
      if (session.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      return session;
    };
    const postOffer = (token: string, origin: string, body: BodyInit = AUDIO_ONLY_SDP) =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/sdp",
          origin,
        },
        body,
        ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
      } as RequestInit & { duplex?: "half" });
    const acceptedGateway = createTalkGatewayControlOwnerTestFixture(
      `voice-accepted-${randomUUID()}`,
    );
    const revokedGateway = createTalkGatewayControlOwnerTestFixture(
      `voice-revoked-${randomUUID()}`,
    );
    let heldBody: ReadableStreamDefaultController<Uint8Array> | undefined;

    try {
      const unrelated = await createReservation();
      const unrelatedResponse = await postOffer(
        unrelated.clientSecret,
        "https://untrusted.example.test",
      );
      expect(unrelatedResponse.status).toBe(403);
      expect(await unrelatedResponse.text()).toBe("Origin not allowed");
      expect(providerRequests).toBe(0);
      await realtime.broker.cancelBrowserSession(unrelated);

      const accepted = await createReservation(acceptedGateway);
      const acceptedResponse = await postOffer(accepted.clientSecret, "http://localhost:25432");
      expect(acceptedResponse.status).toBe(200);
      expect(await acceptedResponse.text()).toBe("v=answer\r\n");
      expect(providerRequests).toBe(1);
      await vi.waitFor(() => expect(sidebandConnections).toBe(1));
      await realtime.broker.cancelBrowserSession(accepted);
      await vi.waitFor(() => expect(acceptedGateway.readLogicalSessionStatus()).toBe("closed"));

      const revoked = await createReservation(revokedGateway);
      expect(realtime.getSessionCounts().pending).toBe(1);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          heldBody = controller;
          controller.enqueue(new TextEncoder().encode("v=0\r\n"));
        },
      });
      const revokedResponsePromise = postOffer(
        revoked.clientSecret,
        "http://localhost:25432",
        body,
      );
      await vi.waitFor(() => expect(realtime.getSessionCounts().pending).toBe(0));
      cfg.gateway!.controlUi = { allowedOrigins: [] };
      const bodyController = heldBody;
      if (!bodyController) {
        throw new Error("Expected held request body controller");
      }
      bodyController.enqueue(new TextEncoder().encode("m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"));
      bodyController.close();
      heldBody = undefined;

      const revokedResponse = await revokedResponsePromise;
      expect(revokedResponse.status).toBe(403);
      expect(await revokedResponse.text()).toBe("Origin not allowed");
      expect(providerRequests).toBe(1);
      await vi.waitFor(() => expect(revokedGateway.readLogicalSessionStatus()).toBe("closed"));
      expect(revokedGateway.events.map((event) => event.type)).toEqual([
        "session.error",
        "session.closed",
      ]);
      expect(realtime.getSessionCounts()).toEqual({
        active: 0,
        inFlight: 0,
        pending: 0,
        reservations: 0,
      });
    } finally {
      heldBody?.error(new Error("proof cleanup"));
      await realtime.cleanup();
      await Promise.all([acceptedGateway.owner.close(), revokedGateway.owner.close()]);
      await closeServer(gatewayServer);
      await closeWebSocketServer(sidebandServer);
      await closeServer(providerServer);
    }
  });

  it("enforces origin changes before reserving or sending an OpenAI offer", async () => {
    const cfg: OpenClawConfig = { gateway: { publicOrigin: "https://old.example.test" } };
    const fetchImpl = vi.fn(
      async () =>
        new Response("v=answer\r\n", {
          status: 201,
          headers: { Location: "/v1/live/rtc_origin_proof" },
        }),
    ) as unknown as typeof fetch;
    const { realtime } = createBroker({ fetchImpl, getConfig: () => cfg });
    const reservation = await realtime.broker.createBrowserSession(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      },
      { type: "api-key", token: "platform-key" },
    );
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected WebRTC reservation");
    }
    const offer = async (origin: string) => {
      const response = createResponseHarness();
      await realtime.handler(
        createRequest({ origin, token: reservation.clientSecret }),
        response.res,
      );
      return response;
    };

    try {
      expect((await offer("https://untrusted.example.test")).res.statusCode).toBe(403);
      expect(realtime.getSessionCounts().pending).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();

      cfg.gateway!.publicOrigin = "https://new.example.test";
      expect((await offer("https://old.example.test")).res.statusCode).toBe(403);
      expect(realtime.getSessionCounts().pending).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();

      cfg.gateway!.controlUi = { allowedOrigins: [] };
      expect((await offer("https://new.example.test")).res.statusCode).toBe(403);
      expect(realtime.getSessionCounts().pending).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();

      delete cfg.gateway!.controlUi;
      const accepted = await offer("https://new.example.test");
      expect(accepted.res.statusCode).toBe(200);
      expect(accepted.end).toHaveBeenCalledWith("v=answer\r\n");
      expect(realtime.getSessionCounts().pending).toBe(0);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      await realtime.cleanup();
    }
  });

  it("revokes a mapped-origin offer held across an explicit policy change", async () => {
    const cfg: OpenClawConfig = { gateway: { publicOrigin: "https://public.example.test" } };
    const fetchImpl = vi.fn(
      async () =>
        new Response("v=answer\r\n", {
          status: 201,
          headers: { Location: "/v1/live/rtc_revoked_origin" },
        }),
    ) as unknown as typeof fetch;
    const { realtime } = createBroker({ fetchImpl, getConfig: () => cfg });
    const gateway = createTalkGatewayControlOwnerTestFixture("voice-revoked-origin");
    const reservation = await realtime.broker.createBrowserSession(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        clientControl: { owner: "gateway" },
        runAgentConsult: gateway.owner.runAgentConsult,
        gatewayControl: gateway.owner.control,
      },
      { type: "api-key", token: "platform-key" },
    );
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected WebRTC reservation");
    }
    const deferred = createDeferredOfferRequest({
      origin: "http://localhost:25432",
      token: reservation.clientSecret,
    });
    const response = createResponseHarness();

    try {
      const handling = withPluginRuntimeGatewayRequestScope(
        { isWebchatConnect: () => false, publishedPort: 25432 },
        () => realtime.handler(deferred.req, response.res),
      );
      await vi.waitFor(() => expect(realtime.getSessionCounts().pending).toBe(0));

      cfg.gateway!.controlUi = { allowedOrigins: [] };
      deferred.finish(AUDIO_ONLY_SDP);

      await expect(handling).resolves.toBe(true);
      expect(response.res.statusCode).toBe(403);
      expect(response.readBody()).toBe("Origin not allowed");
      expect(response.removeHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin");
      expect(fetchImpl).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(gateway.closeLogicalSession).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(gateway.readLogicalSessionStatus()).toBe("closed"));
      expect(gateway.events.map((event) => event.type)).toEqual([
        "session.error",
        "session.closed",
      ]);
      expect(gateway.events[0]?.payload).toEqual(
        expect.objectContaining({ message: "Origin not allowed" }),
      );
      expect(() => gateway.owner.assertOpen()).toThrow("Realtime voice session closed");
      expect(realtime.getSessionCounts()).toEqual({
        active: 0,
        inFlight: 0,
        pending: 0,
        reservations: 0,
      });
    } finally {
      deferred.req.destroy();
      await realtime.cleanup();
      await gateway.owner.close();
    }
  });
});
