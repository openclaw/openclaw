import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";

it("derives display identity from validated settings without commands or state access", async () => {
  const runCommand = vi.fn();
  const openKeyedStore = vi.fn();
  const provider = createCrabboxWorkerProvider({
    state: { openKeyedStore },
    runCommand,
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
