type LanceDbModule = typeof import("@lancedb/lancedb");

const platform = process.platform;
const arch = process.arch;
let loadPromise: Promise<LanceDbModule> | null = null;

export async function loadLanceDbModule(): Promise<LanceDbModule> {
  if (!loadPromise) {
    loadPromise = import("@lancedb/lancedb").catch((error: unknown) => {
      loadPromise = null;
      if (platform === "darwin" && arch === "x64") {
        throw new Error(
          `memory-lancedb: LanceDB runtime is unavailable on ${platform}-${arch}. The bundled @lancedb/lancedb dependency does not publish a native package for this platform. Disable memory-lancedb or switch to a supported memory backend/platform.`,
          { cause: error },
        );
      }
      throw new Error(
        `memory-lancedb: bundled @lancedb/lancedb dependency is unavailable. Install or repair the memory-lancedb plugin package dependencies, then restart OpenClaw. ${String(error)}`,
        { cause: error },
      );
    });
  }
  return await loadPromise;
}
