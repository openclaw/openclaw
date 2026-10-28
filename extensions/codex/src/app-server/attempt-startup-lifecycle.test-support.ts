import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { answerInitialize, type AttemptClientHarness } from "./attempt-startup.test-support.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { resetCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
} from "./shared-client.js";

export function setupStartupLifecycle(tempRoots: Set<string>, beforeClear?: () => void) {
  beforeEach(async () => {
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    beforeClear?.();
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await clearSharedCodexAppServerClientAndWait();
    setManagedCodexPluginRoot(undefined);
    defaultCodexPluginMetadataCache.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });
}

export async function acquireInitializedLease(
  harness: AttemptClientHarness,
  options: Parameters<typeof getLeasedSharedCodexAppServerClient>[0],
) {
  const lease = getLeasedSharedCodexAppServerClient(options);
  await answerInitialize(harness);
  await expect(lease).resolves.toBe(harness.client);
}
