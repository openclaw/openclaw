// Openai tests cover realtime session secret creation behavior.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenAIRealtimeClientSecret,
  createOpenAIRealtimeTranscriptionClientSecret,
} from "./realtime-provider-shared.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

function makeStreamingResponse(params: { chunkCount: number; chunkSize: number }): {
  response: Response;
  getReadCount: () => number;
  wasCanceled: () => boolean;
} {
  let readCount = 0;
  let canceled = false;
  const chunk = new Uint8Array(params.chunkSize);
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount >= params.chunkCount) {
          controller.close();
          return;
        }
        readCount += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  return { response, getReadCount: () => readCount, wasCanceled: () => canceled };
}

function guardedFetch(response: Response): void {
  fetchWithSsrFGuardMock.mockResolvedValue({ response, release: vi.fn() });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected local HTTP server address");
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function expectFetchWithoutDeadlineToStayPending(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const request = fetch(url, { ...init, signal: controller.signal });
  request.catch(() => undefined);

  const outcome = await Promise.race([
    request.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), 30);
    }),
  ]);

  controller.abort();
  await request.catch(() => undefined);
  expect(outcome).toBe("pending");
}

describe("createOpenAIRealtimeClientSecret", () => {
  it("returns client secret from a well-formed response", async () => {
    guardedFetch(
      new Response(
        JSON.stringify({
          client_secret: { value: "eph-secret-abc" },
          expires_at: Math.floor(Date.now() / 1000) + 60,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await createOpenAIRealtimeClientSecret({
      authToken: "sk-test",
      auditContext: "test",
      session: { model: "gpt-4o-realtime-preview" },
    });

    expect(result.value).toBe("eph-secret-abc");
    expect(typeof result.expiresAt).toBe("number");
  });

  it("bounds oversized success response and cancels the stream", async () => {
    // 20 MiB in 1 MiB chunks — well over the 16 MiB cap
    const streamed = makeStreamingResponse({ chunkCount: 20, chunkSize: 1024 * 1024 });
    guardedFetch(streamed.response);

    await expect(
      createOpenAIRealtimeClientSecret({
        authToken: "sk-test",
        auditContext: "test",
        session: { model: "gpt-4o-realtime-preview" },
      }),
    ).rejects.toThrow(/openai\.realtime-session/);

    expect(streamed.wasCanceled()).toBe(true);
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("times out hanging client-secret POST requests", async () => {
    const sockets = new Set<Socket>();
    const requests: string[] = [];
    const server = createServer((request, _response) => {
      requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
      request.resume();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const baseUrl = await listen(server);
    const realFetch = globalThis.fetch;

    try {
      await expectFetchWithoutDeadlineToStayPending(`${baseUrl}/control`, {
        method: "POST",
        body: JSON.stringify({ session: { model: "gpt-4o-realtime-preview" } }),
      });

      fetchWithSsrFGuardMock.mockImplementationOnce(
        async (params: { init?: RequestInit; timeoutMs?: number }) => {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => {
              const error = new Error(
                `simulated hanging POST timed out after ${String(params.timeoutMs)}ms`,
              );
              error.name = "TimeoutError";
              controller.abort(error);
            },
            Math.min(params.timeoutMs ?? 0, 50),
          );
          try {
            return {
              response: await realFetch(`${baseUrl}/realtime/client_secrets`, {
                ...params.init,
                signal: controller.signal,
              }),
              release: vi.fn(async () => {}),
            };
          } finally {
            clearTimeout(timeout);
          }
        },
      );

      await expect(
        createOpenAIRealtimeClientSecret({
          authToken: "sk-test",
          auditContext: "test",
          session: { model: "gpt-4o-realtime-preview" },
        }),
      ).rejects.toThrow("simulated hanging POST timed out after 20000ms");

      expect(fetchWithSsrFGuardMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          timeoutMs: 20_000,
          init: expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ session: { model: "gpt-4o-realtime-preview" } }),
          }),
        }),
      );
      expect(requests).toEqual(["POST /control", "POST /realtime/client_secrets"]);
    } finally {
      await closeServer(server, sockets);
    }
  });

  it("throws the provider error label on oversized body", async () => {
    const streamed = makeStreamingResponse({ chunkCount: 20, chunkSize: 1024 * 1024 });
    guardedFetch(streamed.response);

    await expect(
      createOpenAIRealtimeTranscriptionClientSecret({
        authToken: "sk-test",
        auditContext: "test",
        session: { model: "gpt-4o-transcribe" },
      }),
    ).rejects.toThrow(/openai\.realtime-session/);

    expect(streamed.wasCanceled()).toBe(true);
  });

  it("creates transcription secrets through the current client-secrets endpoint", async () => {
    guardedFetch(
      new Response(JSON.stringify({ value: "ek-transcription", expires_at: 1_800_000_000 }), {
        status: 200,
      }),
    );

    await createOpenAIRealtimeTranscriptionClientSecret({
      authToken: "sk-test",
      auditContext: "test",
      session: { type: "transcription" },
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/realtime/client_secrets",
        init: expect.objectContaining({
          body: JSON.stringify({ session: { type: "transcription" } }),
        }),
      }),
    );
  });

  it("replaces rejected transcription API-key details with bounded guidance", async () => {
    guardedFetch(
      new Response(JSON.stringify({ error: { message: "Incorrect API key provided: secret" } }), {
        status: 401,
      }),
    );

    await expect(
      createOpenAIRealtimeTranscriptionClientSecret({
        authToken: "sk-test",
        auditContext: "test",
        session: { type: "transcription" },
        authRejectedMessage: "Update the transcription API key",
      }),
    ).rejects.toThrow("Update the transcription API key");
  });
});
