import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { bridgeCodexAppServerStartOptions } from "./auth-bridge.js";
import type { CodexAppServerStartOptions } from "./config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function createStartOptions(
  overrides: Partial<CodexAppServerStartOptions>,
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource: "resolved-managed",
    args: ["app-server"],
    headers: { authorization: "Bearer dev-token" },
    ...overrides,
  };
}

it.each([
  { transport: "stdio" as const, homeScope: "agent" as const, proxy: false, managed: true },
  { transport: "stdio" as const, homeScope: "user" as const, proxy: false, managed: false },
  { transport: "stdio" as const, homeScope: "agent" as const, proxy: true, managed: false },
  { transport: "websocket" as const, homeScope: "agent" as const, proxy: false, managed: false },
  { transport: "unix" as const, homeScope: "agent" as const, proxy: false, managed: false },
])(
  "owns unload retention only for managed local starts: $transport/$homeScope/proxy=$proxy",
  async ({ transport, homeScope, proxy, managed }) => {
    await withTempDir("openclaw-codex-managed-unload-", async (agentDir) => {
      vi.stubEnv("CODEX_HOME", path.join(agentDir, "native-home"));
      const startOptions = createStartOptions({
        transport,
        homeScope,
        args: ["-c", "thread_unload_delay_secs=25", "app-server", ...(proxy ? ["proxy"] : [])],
      });
      const bridged = await bridgeCodexAppServerStartOptions({
        startOptions,
        agentDir,
        authProfileId: null,
      });
      expect(bridged.args).toEqual(
        managed
          ? ["-c", "thread_unload_delay_secs=25", "-c", "thread_unload_delay_secs=0", "app-server"]
          : startOptions.args,
      );
    });
  },
);
