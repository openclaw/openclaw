import { withServer } from "openclaw/plugin-sdk/test-env";
import { vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

export async function withRetirementServer<T extends MatrixClient>(
  responseBody: Record<string, string>,
  Client: new (...args: ConstructorParameters<typeof MatrixClient>) => T,
  run: (client: T, baseUrl: string, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  await withServer(
    (request, response) => {
      seen.push(`${request.method ?? "GET"} ${decodeURIComponent(request.url ?? "/")}`);
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(responseBody));
    },
    async (baseUrl) => {
      const client = new Client(baseUrl, "fixture-token", {
        userId: "@bot:example.org",
        deviceId: "fixture",
        encryption: false,
        autoBootstrapCrypto: false,
        ssrfPolicy: { allowPrivateNetwork: true },
      });
      try {
        await run(client, baseUrl, seen);
      } finally {
        vi.useRealTimers();
        await client.stopWithoutPersist().catch(() => {});
      }
    },
  );
}

export function createRetirementTaskRunner() {
  return createMatrixMonitorTaskRunner({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    logVerboseMessage: () => {},
  });
}
