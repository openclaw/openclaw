import { vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import {
  createInitializingClientHarness,
  createStartOptions,
} from "./shared-client-start.test-support.js";
import { getSharedCodexAppServerClient } from "./shared-client.js";

export async function withSharedCodexClientForShutdownTest(
  check: (transport: ReturnType<typeof createInitializingClientHarness>) => Promise<void>,
) {
  const transport = createInitializingClientHarness();
  const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(transport.client);
  try {
    await getSharedCodexAppServerClient({
      authProfileId: null,
      config: {},
      startOptions: createStartOptions({ command: process.execPath, commandSource: "config" }),
      timeoutMs: 5_000,
    });
    await check(transport);
  } finally {
    start.mockRestore();
    await transport.client.closeAndWait();
  }
}
