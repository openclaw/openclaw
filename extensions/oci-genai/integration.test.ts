/**
 * Real-network integration tests for the OCI signed-fetch path.
 *
 * Spins up an in-process HTTP server with `node:http.createServer` and
 * drives requests through the **real** global `fetch` wrapped by
 * `createOciSignedFetch`.  This exercises the actual node network
 * stack — header marshalling, body serialization, response stream
 * reading — so the suite catches issues that a stubbed `fetch` would
 * mask (SSE chunk boundaries, content-length round-tripping, fetch's
 * automatic Content-Length / Host header behaviour interacting with
 * our signed values).
 *
 * No external systems: the localhost server pretends to be OCI's
 * `/openai/v1/chat/completions`.  No credentials, no network egress.
 * For a true live OCI loop, use the `pnpm test:live` lane with real
 * `~/.oci/config` credentials (added later, gated by
 * `OPENCLAW_LIVE_TEST=1`).
 *
 * Coverage:
 *   1. basic non-streaming chat completion
 *   2. streaming SSE response (text/event-stream chunks)
 *   3. tool_calls response (function calling)
 *   4. error path (5xx upstream)
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOciSignedFetch, OciRequestSigner } from "./oci-signer.js";
import { loadOciProfile } from "./profile-loader.js";

const FIXED_NOW_MS = Date.UTC(2026, 4, 6, 0, 0, 0);

type CapturedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

type Responder = (req: CapturedRequest, res: ServerResponse) => Promise<void> | void;

let server: Server;
let baseUrl: string;
let captured: CapturedRequest[] = [];
let responder: Responder = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
};

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[name.toLowerCase()] = value;
      } else if (Array.isArray(value)) {
        headers[name.toLowerCase()] = value.join(", ");
      }
    }
    const body = await readRequestBody(req);
    const reqRecord: CapturedRequest = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers,
      body,
    };
    captured.push(reqRecord);
    try {
      await responder(reqRecord, res);
    } catch (err) {
      if (!res.writableEnded) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end((err as Error).message);
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/openai/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  captured = [];
  responder = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  };
});

describe("real-network integration: signed fetch over node:http", () => {
  let workDir: string;
  let signedFetch: typeof fetch;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "oci-real-"));
    const keyFile = join(workDir, "key.pem");
    const configFile = join(workDir, "config");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
    await writeFile(
      configFile,
      [
        "[DEFAULT]",
        "user=ocid1.user.oc1..u",
        "tenancy=ocid1.tenancy.oc1..t",
        "fingerprint=ab:cd",
        `key_file=${keyFile}`,
      ].join("\n"),
    );
    const profile = await loadOciProfile({ configFile });
    const signer = new OciRequestSigner({ profile, nowMs: FIXED_NOW_MS });
    signedFetch = createOciSignedFetch(signer);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("delivers a basic non-streaming chat completion through the real node network stack", async () => {
    responder = (req, res) => {
      expect(req.headers.authorization).toMatch(/^Signature/);
      expect(req.headers["x-content-sha256"]).toBeTypeOf("string");
      const body = JSON.parse(req.body) as {
        model: string;
        messages: ReadonlyArray<{ role: string; content: string }>;
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Math.floor(FIXED_NOW_MS / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `echo:${body.messages[0].content}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    };

    const requestBody = JSON.stringify({
      model: "meta.llama-3.3-70b-instruct",
      messages: [{ role: "user", content: "ping" }],
    });
    const response = await signedFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer placeholder" },
      body: requestBody,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const parsed = (await response.json()) as {
      choices: ReadonlyArray<{ message: { content: string } }>;
    };
    expect(parsed.choices[0].message.content).toBe("echo:ping");

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].url).toBe("/openai/v1/chat/completions");
    expect(captured[0].headers.authorization).toMatch(/^Signature/);
    expect(captured[0].headers.authorization).not.toMatch(/Bearer/);
    expect(captured[0].headers["content-length"]).toBe(String(requestBody.length));
  });

  it("streams an SSE chat completion (text/event-stream chunks pass through the signer)", async () => {
    responder = (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunks = [
        {
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        },
        {
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
        },
        {
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: " from OCI." }, finish_reason: null }],
        },
        {
          id: "chatcmpl-stream",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    };

    const response = await signedFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "meta.llama-3.3-70b-instruct",
        messages: [{ role: "user", content: "stream me" }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body).not.toBeNull();

    // Read the SSE stream as the OpenAI SDK would, line-by-line.
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();

    const dataLines = raw
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));

    // 4 chunks + the [DONE] sentinel.
    expect(dataLines).toHaveLength(5);
    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");

    // Reassembling the deltas in order gives the full assistant message.
    const assembled = dataLines
      .slice(0, -1)
      .map(
        (line) => JSON.parse(line) as { choices: ReadonlyArray<{ delta?: { content?: string } }> },
      )
      .map((chunk) => chunk.choices[0].delta?.content ?? "")
      .join("");
    expect(assembled).toBe("Hello from OCI.");

    // Outbound was correctly signed.
    expect(captured[0].headers.authorization).toMatch(/^Signature/);
    expect(captured[0].headers["x-content-sha256"]).toBeTypeOf("string");
  });

  it("preserves tool_calls in the response (function calling round-trip)", async () => {
    responder = (req, res) => {
      const body = JSON.parse(req.body) as {
        tools?: ReadonlyArray<{ type: string; function: { name: string } }>;
      };
      // Echo the registered tool back as a tool_call so we can assert the
      // shape survived the signer wrapper.
      const toolName = body.tools?.[0]?.function.name ?? "noop";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-tools",
          object: "chat.completion",
          created: Math.floor(FIXED_NOW_MS / 1000),
          model: "meta.llama-3.3-70b-instruct",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_abc",
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: JSON.stringify({ city: "Phoenix" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        }),
      );
    };

    const response = await signedFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "meta.llama-3.3-70b-instruct",
        messages: [{ role: "user", content: "What's the weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      choices: ReadonlyArray<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: ReadonlyArray<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };

    expect(parsed.choices[0].finish_reason).toBe("tool_calls");
    expect(parsed.choices[0].message.tool_calls).toHaveLength(1);
    const call = parsed.choices[0].message.tool_calls![0];
    expect(call.function.name).toBe("get_weather");
    expect(JSON.parse(call.function.arguments)).toEqual({ city: "Phoenix" });

    // The outbound tools array is still intact in the request body the
    // server saw — the signer hashed it, didn't transform it.
    const outbound = JSON.parse(captured[0].body) as {
      tools: ReadonlyArray<{ type: string; function: { name: string } }>;
    };
    expect(outbound.tools[0].function.name).toBe("get_weather");
  });

  it("propagates 5xx HTTP errors as Response objects without swallowing", async () => {
    responder = (_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("OCI inference cluster is busy");
    };

    const response = await signedFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("OCI inference cluster is busy");
    // Even on error, we still successfully signed the request.
    expect(captured[0].headers.authorization).toMatch(/^Signature/);
  });
});
