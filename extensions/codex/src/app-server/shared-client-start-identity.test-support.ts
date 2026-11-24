import { expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import {
  createInitializingClientHarness,
  createStartOptions,
} from "./shared-client-start.test-support.js";
import {
  getSharedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { resolveCodexAppServerSpawnEnv, withCodexAppServerGitConfig } from "./transport-stdio.js";

export function registerSharedClientStartIdentityTests() {
  it.each(["catalog-first", "turn-first"])(
    "reuses the native writer across Git policy preparation: %s",
    async (order) => {
      const start = vi
        .spyOn(CodexAppServerClient, "start")
        .mockImplementation(async () => createInitializingClientHarness().client);
      const base = createStartOptions({
        homeScope: "user",
        env: { GIT_CONFIG_PARAMETERS: "'user.name=Native'" },
      });
      const turn = withCodexAppServerGitConfig(base, "'maintenance.auto=false' 'gc.auto=0'");
      const starts = order === "catalog-first" ? [base, turn] : [turn, base];
      const first = await getLeasedSharedCodexAppServerClient({ startOptions: starts[0] });
      const second = await getLeasedSharedCodexAppServerClient({ startOptions: starts[1] });
      try {
        expect(second).toBe(first);
        expect(start).toHaveBeenCalledTimes(1);
        const startedOptions = start.mock.calls[0]?.[0];
        if (!startedOptions) {
          throw new Error("Expected app-server process options");
        }
        expect(resolveCodexAppServerSpawnEnv(startedOptions, {}).GIT_CONFIG_PARAMETERS).toBe(
          "'user.name=Native' 'maintenance.auto=false' 'gc.auto=0'",
        );
      } finally {
        releaseLeasedSharedCodexAppServerClient(second);
        releaseLeasedSharedCodexAppServerClient(first);
      }
    },
  );

  it.each(["websocket", "unix"] as const)(
    "preserves explicit start options over the plugin endpoint for $0",
    async (transport) => {
      const harness = createInitializingClientHarness();
      const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

      const client = await getSharedCodexAppServerClient({
        pluginConfig: {
          appServer: {
            transport,
            url: transport === "unix" ? "unix://" : "ws://127.0.0.1:39175",
          },
        },
        startOptions: createStartOptions({
          transport: "websocket",
          args: [],
          url: "ws://127.0.0.1:39176",
        }),
        timeoutMs: 1_000,
      });

      expect(client).toBe(harness.client);
      expect(startSpy).toHaveBeenCalledWith(
        expect.objectContaining({ transport: "websocket", url: "ws://127.0.0.1:39176" }),
        expect.anything(),
      );
      await client.closeAndWait();
    },
  );
}
