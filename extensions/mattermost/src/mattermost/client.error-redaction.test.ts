import { describe, expect, it } from "vitest";
import { createMattermostClient, readMattermostError, uploadMattermostFile } from "./client.js";

describe("Mattermost reflected credential diagnostics", () => {
  it.each([
    {
      name: "bare text",
      contentType: "text/plain",
      body: "upstream rejected abcdefghijklmnopqrstuvwxyz",
      expected: "upstream rejected ***",
    },
    {
      name: "bare JSON message",
      contentType: "application/json",
      body: '{"message":"upstream rejected abcdefghijklmnopqrstuvwxyz"}',
      expected: "upstream rejected ***",
    },
    {
      name: "serialized object fallback",
      contentType: "application/json",
      body: '{"context":"retry later","echoed":"abcdefghijklmnopqrstuvwxyz"}',
      expected: '{"context":"retry later","echoed":"***"}',
    },
    {
      name: "object-valued message",
      contentType: "application/json",
      body: '{"message":{"context":"retry later","echoed":"abcdefghijklmnopqrstuvwxyz"}}',
      expected: '{"message":{"context":"retry later","echoed":"***"}}',
    },
    {
      name: "array-valued message",
      contentType: "application/json",
      body: '{"message":["retry later","abcdefghijklmnopqrstuvwxyz"]}',
      expected: '{"message":["retry later","***"]}',
    },
    {
      name: "non-string message without credentials",
      contentType: "application/json",
      body: '{"message":503,"context":"retry later"}',
      expected: '{"message":503,"context":"retry later"}',
    },
  ])("redacts the active credential and preserves $name diagnostics", async (scenario) => {
    const response = new Response(scenario.body, {
      status: 503,
      headers: { "content-type": scenario.contentType },
    });

    const detail = await readMattermostError(response, {
      Authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
    });

    expect(detail).toBe(scenario.expected);
  });

  it("redacts a credential cut by the error-body limit and cancels unread data", async () => {
    const safePrefix = "upstream diagnostic " + ".".repeat(8192 - 20 - 12);
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(safePrefix + "abcdefghijklmnopqrstuvwxyz unread suffix"),
          );
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 503, headers: { "content-type": "text/plain" } },
    );

    const detail = await readMattermostError(response, {
      Authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
    });

    expect(detail).toBe(safePrefix + "***");
    expect(canceled).toBe(true);
  });
  it.each(["request", "upload"] as const)(
    "redacts an active bare credential reflected by the %s path",
    async (route) => {
      const client = createMattermostClient({
        baseUrl: "https://chat.example.com",
        botToken: "abcdefghijklmnopqrstuvwxyz",
        fetchImpl: async (_url, init) => {
          const authorization = new Headers(init?.headers).get("Authorization");
          expect(authorization).toBe("Bearer abcdefghijklmnopqrstuvwxyz");
          return new Response(`upstream rejected ${authorization?.slice(7)}`, {
            status: 503,
            statusText: "Service Unavailable",
          });
        },
      });

      const operation =
        route === "request"
          ? client.request("/users/me")
          : uploadMattermostFile(client, {
              channelId: "channel-1",
              buffer: Buffer.from("fixture upload"),
              fileName: "proof.txt",
              contentType: "text/plain",
            });

      await expect(operation).rejects.toThrow(
        "Mattermost API 503 Service Unavailable: upstream rejected ***",
      );
    },
  );
});
