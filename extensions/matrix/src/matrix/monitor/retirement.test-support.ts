import http from "node:http";
import { afterEach, vi } from "vitest";
import { MatrixClient } from "../sdk.js";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

export function useRetirementServer(responseBody: Record<string, string>) {
  let server: http.Server | undefined;
  let client: MatrixClient | undefined;
  const seen: string[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    await client?.stopWithoutPersist().catch(() => {});
    client = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
  });
  return {
    seen,
    async start<T extends MatrixClient>(
      this: void,
      Client: new (...args: ConstructorParameters<typeof MatrixClient>) => T,
    ) {
      seen.length = 0;
      server = http.createServer((request, response) => {
        seen.push(`${request.method ?? "GET"} ${decodeURIComponent(request.url ?? "/")}`);
        request.resume();
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(responseBody));
      });
      await new Promise<void>((resolve) => {
        server?.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("proof server did not bind");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const active = new Client(baseUrl, "fixture-token", {
        userId: "@bot:example.org",
        deviceId: "fixture",
        encryption: false,
        autoBootstrapCrypto: false,
        ssrfPolicy: { allowPrivateNetwork: true },
      });
      client = active;
      return { client: active, baseUrl };
    },
  };
}

export function createRetirementTaskRunner() {
  return createMatrixMonitorTaskRunner({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    logVerboseMessage: () => {},
  });
}
