import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import {
  createProviderHttpError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { rawDataToString } from "openclaw/plugin-sdk/realtime-voice-provider";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { acquireTestPortBlock, runQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

// Credential-service results and provider protocol are synthetic. HTTP, DNS, WebSocket,
// response parsing and authority decisions are real; this does not qualify OpenAI's endpoint.
it.for(["credentials", "dns", "final", "authorized"] as const)(
  "enforces transcription authority over real local transport: %s",
  async (phase, { signal }) => {
    const credentialEntered = createDeferred();
    const credentialReleased = createDeferred();
    const dnsResolved = createDeferred();
    const dnsReleased = createDeferred();
    const commitReceived = createDeferred<WebSocket>();
    const terminal = createDeferred();
    const profileValue = randomUUID();
    const sessionValue = randomUUID();
    const revokedError = new Error("Transcription authority revoked");
    const onTranscript = vi.fn(() => terminal.resolve());
    const onError = vi.fn(() => terminal.resolve());
    const requests: Array<{ method?: string; path?: string; body: string; authorized: boolean }> =
      [];
    const frames: Array<{ type: string; [key: string]: unknown }> = [];
    const socketAuth: boolean[] = [];
    let current = true;
    let preparedRequests = 0;
    let resolvedLookups = 0;
    const resources: {
      session?: ReturnType<typeof createRealtimeTranscriptionWebSocketSession>;
      connectionResult?: Promise<unknown>;
      wss?: WebSocketServer;
    } = {};

    const server = createServer((request, response) => {
      const entry = {
        method: request.method,
        path: request.url,
        body: "",
        authorized: request.headers.authorization === "Bearer " + profileValue,
      };
      // Count arrivals before body completion so even a partial disclosure fails the assertion.
      requests.push(entry);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        entry.body = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ value: sessionValue }));
      });
    });
    const claim = await acquireTestPortBlock({ offsets: [0], signal });
    onTestFinished(() =>
      runQaGatewayFixture(
        async () => {
          current = false;
          credentialReleased.resolve();
          dnsReleased.resolve();
          resources.session?.close();
          await resources.connectionResult;
        },
        async () => {
          const sockets = resources.wss;
          if (sockets) {
            sockets.clients.forEach((socket) => socket.terminate());
            await new Promise<void>((resolve, reject) => {
              sockets.close((error) => (error ? reject(error) : resolve()));
            });
          }
        },
        async () => {
          server.closeAllConnections();
          if (server.listening) {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
        },
        () => claim.release(),
      ),
    );
    const origin = "http://localhost:" + claim.port;
    const wss = new WebSocketServer({ server });
    resources.wss = wss;
    wss.on("connection", (socket, request) => {
      socketAuth.push(request.headers.authorization === "Bearer " + sessionValue);
      socket.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as {
          type: string;
          [key: string]: unknown;
        };
        frames.push(frame);
        if (frame.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
        } else if (frame.type === "input_audio_buffer.commit") {
          commitReceived.resolve(socket);
        }
      });
    });
    await withinTest(
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port: claim.port, host: "127.0.0.1", signal }, () => {
          server.off("error", reject);
          resolve();
        });
      }),
      signal,
    );

    const unexpected = () => {
      throw new Error("Unexpected unrelated host operation");
    };
    const runtime: OpenAIRealtimeHost = {
      resolveAgentDir: unexpected,
      isProviderAuthProfileConfigured: unexpected,
      isProviderAuthProfileConfiguredAsync: unexpected,
      resolveProviderAuthProfileApiKey: async () => {
        credentialEntered.resolve();
        await credentialReleased.promise;
        return profileValue;
      },
      resolveProviderRequestHeaders: ({ defaultHeaders }) => defaultHeaders,
      createRealtimeTranscriptionWebSocketSession: (options) =>
        createRealtimeTranscriptionWebSocketSession({
          ...options,
          url: origin.replace("http", "ws"),
        }),
      captureWsEventAsync: unexpected,
      createDebugProxyWebSocketAgent: unexpected,
      resolveDebugProxySettings: unexpected,
      fetchWithSsrFGuard: (params) => {
        preparedRequests += 1;
        expect(params.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
        // Adapt only the external destination. Keep beforeRequest, DNS pinning and native fetch.
        return fetchWithSsrFGuard({
          ...params,
          url: origin + new URL(params.url).pathname,
          policy: { allowedOrigins: [origin], hostnameAllowlist: ["localhost"] },
          capture: false,
          signal,
          lookupFn: async (hostname, options) => {
            const addresses = await lookup(hostname, options);
            resolvedLookups += 1;
            dnsResolved.resolve();
            await dnsReleased.promise;
            return addresses;
          },
        });
      },
      createProviderHttpError,
      readProviderJsonResponse,
      readProviderTextResponse: unexpected,
      formatErrorMessage: unexpected,
      warn: unexpected,
      redactSensitiveText: unexpected,
    };
    const session = buildOpenAIRealtimeTranscriptionProvider(runtime).createSession({
      providerConfig: { prompt: "PostgreSQL and Ariadna" },
      assertCurrent: () => {
        if (!current) {
          throw revokedError;
        }
      },
      onTranscript,
      onError,
    });
    resources.session = session;
    const connecting = session.connect();
    const connectionResult = connecting.then(
      () => undefined,
      (error: unknown) => error,
    );
    resources.connectionResult = connectionResult;
    await withinTest(
      awaitGateBeforeSettlement(
        credentialEntered.promise,
        connecting,
        "Connect settled before credential resolution",
      ),
      signal,
    );
    current = phase !== "credentials";
    credentialReleased.resolve();
    if (phase === "credentials") {
      // Let the original defect reach the real HTTP sink instead of hanging at the DNS fixture.
      dnsReleased.resolve();
    } else {
      await withinTest(
        awaitGateBeforeSettlement(dnsResolved.promise, connecting, "Connect settled before DNS"),
        signal,
      );
      expect(resolvedLookups).toBe(1);
      current = phase !== "dns";
      dnsReleased.resolve();
    }
    const error = await withinTest(connectionResult, signal);
    if (phase === "credentials" || phase === "dns") {
      // Destination-side receipts, not a mocked fetch invocation, prove zero disclosure.
      expect(requests).toHaveLength(0);
      expect(socketAuth).toHaveLength(0);
      expect(preparedRequests).toBe(phase === "credentials" ? 0 : 1);
      expect(resolvedLookups).toBe(phase === "credentials" ? 0 : 1);
      expect(error).toBe(revokedError);
      expect(onError).toHaveBeenCalledExactlyOnceWith(revokedError);
      expect(onTranscript).not.toHaveBeenCalled();
      return;
    }

    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/realtime/client_secrets",
      authorized: true,
    });
    const expectedSession = {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { model: "gpt-4o-transcribe", prompt: "PostgreSQL and Ariadna" },
        },
      },
    };
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ session: expectedSession });
    expect(socketAuth).toEqual([true]);
    expect(frames).toMatchObject([{ type: "session.update", session: expectedSession }]);
    expect(session.isConnected()).toBe(true);
    session.sendAudio(Buffer.alloc(800, 1));
    session.close();
    session.close();
    const socket = await withinTest(commitReceived.promise, signal);
    expect(frames.map((frame) => frame.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
    ]);
    current = phase !== "final";
    socket.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "final-item" }));
    socket.send(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "final-item",
        transcript: "final caller sentence",
      }),
    );
    await withinTest(terminal.promise, signal);
    if (phase === "final") {
      expect(onTranscript).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledExactlyOnceWith(revokedError);
    } else {
      expect(onTranscript).toHaveBeenCalledExactlyOnceWith("final caller sentence");
      expect(onError).not.toHaveBeenCalled();
    }
    expect(socketAuth).toHaveLength(1);
    expect(requests).toHaveLength(1);
  },
);
