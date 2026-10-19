import { afterEach, describe, expect, it, vi } from "vitest";
import { getCodexNativeProcessClient } from "./native-process-authority.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { createClientHarness } from "./test-support.js";

afterEach(async () => {
  await sandboxExecServerRegistry.closeAll();
});

describe("sandbox exec-server authority subscriptions", () => {
  it.each(["release", "registration failure", "client close", "registry close"] as const)(
    "releases the client subscription after %s",
    async (outcome) => {
      const { client } = createClientHarness({
        onWrite(line, send) {
          const request = JSON.parse(line) as { id: number; method: string };
          expect(request.method).toBe("environment/add");
          send(
            outcome === "registration failure"
              ? { id: request.id, error: { code: -32603, message: "registration failed" } }
              : { id: request.id, result: {} },
          );
        },
      });
      // The process authority itself belongs to the physical client's lifetime.
      getCodexNativeProcessClient(client);
      const retained = new Set<Parameters<typeof client.addCloseHandler>[0]>();
      const addCloseHandler = client.addCloseHandler.bind(client);
      vi.spyOn(client, "addCloseHandler").mockImplementation((handler) => {
        retained.add(handler);
        const unsubscribe = addCloseHandler(handler);
        return () => {
          retained.delete(handler);
          unsubscribe();
        };
      });
      const sandbox = createSandboxContext({});
      const acquire = () =>
        ensureCodexSandboxExecServerEnvironment({
          client,
          sandbox,
          requireProcessAuthority: true,
        });

      try {
        if (outcome === "registration failure") {
          await expect(acquire()).rejects.toThrow("registration failed");
        } else {
          await acquire();
          expect(retained.size).toBe(1);
          if (outcome === "release") {
            // A shared lease keeps the subscription until the final release.
            await acquire();
            await releaseCodexSandboxExecServerEnvironment(sandbox);
            expect(retained.size).toBe(1);
            await releaseCodexSandboxExecServerEnvironment(sandbox);
            expect(retained.size).toBe(0);
            // A later turn can recreate the server without accumulating callbacks.
            await acquire();
            expect(retained.size).toBe(1);
            await releaseCodexSandboxExecServerEnvironment(sandbox);
            await releaseCodexSandboxExecServerEnvironment(sandbox);
          } else if (outcome === "client close") {
            client.close();
          } else {
            await sandboxExecServerRegistry.closeAll();
          }
        }
        expect(retained.size).toBe(0);
      } finally {
        client.close();
      }
    },
  );
});
