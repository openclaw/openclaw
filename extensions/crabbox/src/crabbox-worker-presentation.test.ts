import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";

afterEach(() => vi.restoreAllMocks());

it("derives display identity from validated settings without commands or state access", async () => {
  const runCommand = vi.spyOn(processRunner, "runCrabboxProcess");
  const openKeyedStore = vi.fn();
  const provider = createCrabboxWorkerProvider({
    state: { openKeyedStore },
    wallpaperPath: fileURLToPath(
      new URL("../assets/openclaw-worker-wallpaper.png", import.meta.url),
    ),
  });
  const profile = { provider: "aws", ttl: "24h", idleTimeout: "60m" };
  try {
    expect(provider.resolveDisplayId?.({ ...profile, provider: " AWS " })).toBe("aws");
    expect(provider.resolveDisplayId?.({ ...profile, provider: "azure" })).toBe("azure");
    expect(() => provider.resolveDisplayId?.({ ...profile, provider: "" })).toThrow();
    expect(() => provider.resolveDisplayId?.({ ...profile, unexpected: true })).toThrow();
    expect(runCommand).not.toHaveBeenCalled();
    expect(openKeyedStore).not.toHaveBeenCalled();
  } finally {
    await provider.dispose();
  }
});
