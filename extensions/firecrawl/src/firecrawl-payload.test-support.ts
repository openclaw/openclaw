import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, vi } from "vitest";

export function mockFirecrawlResponses() {
  installPinnedHostnameTestHooks();
  afterEach(() => vi.restoreAllMocks());
  return (payload: Record<string, unknown>) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(payload));
  };
}
