import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import * as Lark from "@larksuiteoapi/node-sdk";
import { onTestFinished } from "vitest";

type LoopbackRequest = { method: string; path: string; url: URL; rawBody: string };

export function createLoopbackServer(handle: (request: LoopbackRequest) => unknown) {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = handle({
        method: request.method ?? "",
        path: url.pathname,
        url,
        rawBody: await text(request),
      });
      response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
}

export async function listenLoopback(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

export async function createLoopbackHttp(server: ReturnType<typeof createServer>) {
  const origin = await listenLoopback(server);
  const transport = Object.create(Lark.defaultHttpInstance) as Lark.HttpInstance;
  transport.request = async (options) => {
    const upstream = new URL(options.url ?? "");
    const target = new URL(`${upstream.pathname}${upstream.search}`, origin);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined && value !== null) {
        target.searchParams.set(key, String(value));
      }
    }
    const method = options.method ?? "GET";
    const response = await fetch(target, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: JSON.stringify(options.data ?? {}) }),
    });
    return response.json();
  };
  return transport;
}
