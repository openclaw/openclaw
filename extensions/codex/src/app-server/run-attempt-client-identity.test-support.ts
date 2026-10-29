import { vi } from "vitest";
import type { CodexAppServerClientOptions } from "./shared-client.js";
import { createCodexLifecycleTurnHarness as createLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

export function createCodexLifecycleTurnHarness(
  options: Parameters<typeof createLifecycleHarness>[0] & { codexHome?: string },
) {
  const harness = createLifecycleHarness(options);
  if (options.codexHome) {
    // The baseline wire fixture predates initialize.codexHome. Keep real metadata I/O
    // and client ownership while supplying only the synthetic native runtime identity.
    const getRuntimeIdentity = harness.client.getRuntimeIdentity.bind(harness.client);
    vi.spyOn(harness.client, "getRuntimeIdentity").mockImplementation(() => ({
      ...getRuntimeIdentity(),
      serverVersion: CODEX_APP_SERVER_VERSION,
      codexHome: options.codexHome,
    }));
  }
  return harness;
}

export type CodexLifecycleHarnessOptions = {
  codexHome?: string;
  persistedThreads?: Parameters<typeof createLifecycleHarness>[0]["persistedThreads"];
  onStart?: (
    authProfileId: string | undefined,
    agentDir: string | undefined,
    options: CodexAppServerClientOptions | undefined,
  ) => void;
};
