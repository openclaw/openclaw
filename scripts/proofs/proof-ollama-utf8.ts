import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseNdjsonStream } from "../../extensions/ollama/src/stream.runtime.js";

async function drainOverHttp(bytes: Uint8Array): Promise<string> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    // Real HTTP transport boundary: the production parser consumes the body
    // stream of an actual fetch response, not a hand-built reader.
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true }),
    });
    if (!response.body) {
      throw new Error("response body missing");
    }
    const chunks: unknown[] = [];
    for await (const chunk of parseNdjsonStream(response.body.getReader())) {
      chunks.push(chunk);
    }
    return JSON.stringify(chunks);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function main(): Promise<void> {
  const valid = new TextEncoder().encode('{"message":{"role":"assistant","content":"hello"}}\n');
  const corrupted = new Uint8Array(valid);
  corrupted[valid.indexOf(0x68) + 1] = 0xff;

  try {
    const parsed = await drainOverHttp(corrupted);
    console.log(`corrupted stream: accepted, parsed=${parsed}`);
  } catch (error) {
    console.log(`corrupted stream: rejected (${(error as Error).message})`);
  }

  // A lone leading UTF-8 byte at EOF stays buffered by the continuing stream
  // decode and must reject when the fatal decoder is finalized after the body.
  try {
    const parsed = await drainOverHttp(new Uint8Array([...valid, 0xc3]));
    console.log(`truncated terminal UTF-8: accepted, parsed=${parsed}`);
  } catch (error) {
    console.log(`truncated terminal UTF-8: rejected (${(error as Error).message})`);
  }

  console.log(`valid stream: ${await drainOverHttp(valid)}`);
}

void main();
