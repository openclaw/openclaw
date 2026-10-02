import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { createMockServerTestHarness, getJson } from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

it("rejects an oversized upload without taking down the provider", async () => {
  const server = await startMockServer();
  const result = await postRawWebhook({
    url: `${server.baseUrl}/v1/responses`,
    body: "{}",
    contentLength: 16 * 1024 * 1024 + 1,
    headers: { "content-type": "application/json" },
  });
  expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
  expect(JSON.parse(result.body)).toEqual({ error: "Payload too large" });
  expect(result.closedByServer).toBe(true);
  expect(await getJson(server, "/healthz")).toEqual({ ok: true, status: "live" });
});
