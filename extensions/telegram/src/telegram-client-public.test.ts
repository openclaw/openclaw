import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Api } from "grammy";
import { expect, it } from "vitest";
import {
  createTelegramClientFetch,
  getOrCreateAccountThrottler,
  resolveTelegramTransport,
} from "../runtime-api.js";

it("composes the public native transport/client/throttler with actual grammY getFile and service shutdown", async () => {
  const requests: string[] = [];
  let hold = false;
  let arrived: (() => void) | undefined;
  const server = createServer((request, response) => {
    request.resume();
    requests.push(request.url!);
    response.writeHead(200, { "content-type": "application/json" });
    if (hold) {
      response.write('{"ok":true,"result":');
      arrived?.();
    } else {
      response.end(
        JSON.stringify({
          ok: true,
          result: { file_id: "own", file_unique_id: "stable", file_path: "voice.ogg" },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shutdown = new AbortController();
  const transport = resolveTelegramTransport();
  try {
    const token = "123:public-client-proof";
    const limiter = getOrCreateAccountThrottler(token);
    expect(getOrCreateAccountThrottler(token)).toBe(limiter);
    const api = new Api(token, {
      apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      fetch: createTelegramClientFetch({
        fetchImpl: transport.fetch,
        shutdownSignal: shutdown.signal,
        transport,
      }),
    });
    api.config.use(limiter.transformer);
    expect((await api.getFile("own")).file_path).toBe("voice.ogg");
    hold = true;
    const headers = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const pending = api.getFile("own");
    const failure = expect(pending).rejects.toBeInstanceOf(Error);
    await headers;
    shutdown.abort(new Error("service stopped"));
    await failure;
    expect(requests).toEqual(Array(2).fill("/bot123:public-client-proof/getFile"));
  } finally {
    shutdown.abort();
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
