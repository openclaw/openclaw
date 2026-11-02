import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createBraveWebSearchProvider } from "./brave-web-search-provider.js";

const apiKey = "brave-live-proof-key";

function createTool(baseUrl: string) {
  const tool = createBraveWebSearchProvider().createTool({
    config: {
      plugins: {
        entries: { brave: { config: { webSearch: { apiKey, mode: "llm-context", baseUrl } } } },
      },
    },
    searchConfig: { timeoutSeconds: 5 },
  });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return tool;
}

async function listen(): Promise<{ server: Server; port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    seen.push(request.headers["x-subscription-token"]?.toString() ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ grounding: { generic: [] } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP port");
  }
  return { server, port: address.port, seen };
}

describe("Brave base URL live transport", () => {
  it("sends the API key to loopback proxies and refuses metadata targets", async () => {
    const { server, port, seen } = await listen();
    try {
      const loopback = await createTool(`http://127.0.0.1:${port}`).execute({
        query: "loopback-proof",
      });
      const localName = await createTool(`http://localhost:${port}`).execute({
        query: "localhost-proof",
      });
      await expect(
        createTool("http://169.254.169.254/latest").execute({ query: "link-local-proof" }),
      ).rejects.toThrow(/metadata|link-local/);
      await expect(
        createTool("https://metadata.google.internal").execute({ query: "metadata-proof" }),
      ).rejects.toThrow(/metadata|link-local/);
      expect(loopback).toMatchObject({ provider: "brave" });
      expect(localName).toMatchObject({ provider: "brave" });
      expect(seen).toEqual([apiKey, apiKey]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
