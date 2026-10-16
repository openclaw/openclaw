import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";

export async function startStalledSlackApiServer(events: string[]) {
  let requestCount = 0;
  let requestUrl: string | undefined;
  const requests = new Map<
    number,
    {
      received: ReturnType<typeof createDeferred<void>>;
      closed: ReturnType<typeof createDeferred<void>>;
    }
  >();
  const requestLifecycle = (number: number) => {
    let lifecycle = requests.get(number);
    if (!lifecycle) {
      lifecycle = { received: createDeferred<void>(), closed: createDeferred<void>() };
      requests.set(number, lifecycle);
    }
    return lifecycle;
  };
  const server = createServer((request) => {
    requestCount += 1;
    requestUrl = request.url;
    const lifecycle = requestLifecycle(requestCount);
    events.push("request");
    request.resume();
    request.socket.once("close", () => {
      events.push("socket-closed");
      lifecycle.closed.resolve();
    });
    lifecycle.received.resolve();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    get requestCount() {
      return requestCount;
    },
    get requestUrl() {
      return requestUrl;
    },
    waitForRequest: (number: number) => requestLifecycle(number).received.promise,
    waitForRequestClose: (number: number) => requestLifecycle(number).closed.promise,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
