import { describe, expect, it } from "vitest";
import { withLocalServiceResponseDiagnostics } from "./provider-local-service-response.js";

describe("local service HTTP failure diagnostics", () => {
  it("preserves HTTP error classification and retry metadata while adding stderr", async () => {
    const response = new Response(
      '{"error":{"message":"model failed to load","type":"server_error","code":"load_failed"},"request_id":"fixture-request"}',
      {
        status: 503,
        statusText: "Service Unavailable",
        headers: {
          "content-type": "application/json",
          "content-length": "126",
          "retry-after": "2",
          "x-request-id": "fixture-request",
        },
      },
    );

    const enhanced = await withLocalServiceResponseDiagnostics(
      response,
      "; stderr: loader: cannot open missing-🦞.gguf",
    );

    expect(enhanced.status).toBe(503);
    expect(enhanced.statusText).toBe("Service Unavailable");
    expect(enhanced.headers.get("retry-after")).toBe("2");
    expect(enhanced.headers.get("x-request-id")).toBe("fixture-request");
    expect(enhanced.headers.get("content-type")).toBe("application/json");
    expect(enhanced.headers.get("content-length")).toBeNull();
    await expect(enhanced.json()).resolves.toEqual({
      error: {
        message: "model failed to load; stderr: loader: cannot open missing-🦞.gguf",
        type: "server_error",
        code: "load_failed",
      },
      request_id: "fixture-request",
    });
  });

  it.each([
    { name: "success", body: '{"choices":[]}', status: 200, tail: "; stderr: old warning" },
    { name: "missing tail", body: '{"error":{"message":"failed"}}', status: 500, tail: "" },
    { name: "plain text", body: "model unavailable\n", status: 500, tail: "; stderr: failed" },
    { name: "malformed JSON", body: '{"error":', status: 500, tail: "; stderr: failed" },
    { name: "scalar JSON", body: "null", status: 500, tail: "; stderr: failed" },
    {
      name: "non-message error",
      body: '{"error":{"code":5}}',
      status: 500,
      tail: "; stderr: failed",
    },
    {
      name: "oversized JSON",
      body: JSON.stringify({ error: { message: "x".repeat(65 * 1024) } }),
      status: 500,
      tail: "; stderr: failed",
    },
    {
      name: "JSON that would exceed the SDK body cap after expansion",
      body: JSON.stringify({ error: { message: "failed" }, detail: "x".repeat(64 * 1024 - 80) }),
      status: 500,
      tail: `; stderr: ${"y".repeat(128)}`,
    },
  ])("leaves $name bytes unchanged", async ({ body, status, tail }) => {
    const response = new Response(body, { status });
    expect(await withLocalServiceResponseDiagnostics(response, tail)).toBe(response);
    await expect(response.text()).resolves.toBe(body);
  });

  it("keeps the latest stderr inside the SDK's message display limit", async () => {
    const response = new Response(JSON.stringify({ error: { message: "x".repeat(6000) } }), {
      status: 500,
    });
    const enhanced = await withLocalServiceResponseDiagnostics(
      response,
      `; stderr: ${"y".repeat(6000)}\nmissing model file`,
    );
    const body = await enhanced.text();
    expect(body.length).toBeLessThanOrEqual(4096 + 32);
    expect(body).toContain("missing model file");
  });

  it("redacts reflected credentials before clipping a provider message", async () => {
    const credential = "synthetic-reflected-provider-credential";
    const response = new Response(
      JSON.stringify({ error: { message: `${"x".repeat(2038)}${credential} model load failed` } }),
      { status: 500 },
    );
    const enhanced = await withLocalServiceResponseDiagnostics(
      response,
      "; stderr: missing model file",
      undefined,
      { Authorization: `Bearer ${credential}` },
    );
    const body = await enhanced.text();
    expect(body).not.toContain("synthetic-");
    expect(body).toContain("***");
    expect(body).toContain("missing model file");
  });

  it("leaves the original body failure authoritative", async () => {
    const failure = new Error("fixture connection closed");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(failure);
        },
      }),
      { status: 500 },
    );
    expect(await withLocalServiceResponseDiagnostics(response, "; stderr: failed")).toBe(response);
    await expect(response.text()).rejects.toBe(failure);
  });

  it.each(["before", "during"] as const)(
    "does not add stale diagnostics when the request aborts %s body inspection",
    async (when) => {
      const abort = new AbortController();
      const body = '{"error":{"message":"model failed to load"}}';
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
              abort.abort(new Error("caller cancelled"));
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 500 },
      );
      if (when === "before") {
        abort.abort(new Error("caller cancelled"));
      }

      expect(
        await withLocalServiceResponseDiagnostics(response, "; stderr: old failure", abort.signal),
      ).toBe(response);
      await expect(response.text()).resolves.toBe(body);
    },
  );
});
