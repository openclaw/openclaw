import type { BoxLiteSettings } from "../../config/types.sandbox.js";

export type BoxLiteExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type BoxHandle = {
  run(cmd: string, ...args: string[]): Promise<BoxLiteExecResult>;
  copyIn(hostPath: string, containerDest: string): Promise<void>;
  copyOut(containerSrc: string, hostDest: string): Promise<void>;
  stop(): Promise<void>;
};

type BoxEntry = {
  handle: BoxHandle;
  createdAtMs: number;
  lastUsedAtMs: number;
};

const DEFAULT_IMAGE = "alpine:latest";
const DEFAULT_MEMORY_MIB = 512;
const DEFAULT_CPUS = 2;
const DEFAULT_WORKDIR = "/workspace";

// In-memory registry keyed by scope key.
const activeBoxes = new Map<string, BoxEntry>();
// In-flight creation promises to prevent TOCTOU races.
const inFlightCreations = new Map<string, Promise<BoxHandle>>();

export async function isBoxLiteAvailable(): Promise<boolean> {
  try {
    await import("@boxlite-ai/boxlite");
    return true;
  } catch {
    return false;
  }
}

export async function ensureBoxLiteBox(
  scopeKey: string,
  config?: BoxLiteSettings,
): Promise<BoxHandle> {
  const existing = activeBoxes.get(scopeKey);
  if (existing) {
    existing.lastUsedAtMs = Date.now();
    return existing.handle;
  }

  // Deduplicate concurrent creation for the same scope key.
  const pending = inFlightCreations.get(scopeKey);
  if (pending) {
    return pending;
  }

  const creation = createBox(scopeKey, config).finally(() => {
    inFlightCreations.delete(scopeKey);
  });
  inFlightCreations.set(scopeKey, creation);
  return creation;
}

async function createBox(scopeKey: string, config?: BoxLiteSettings): Promise<BoxHandle> {
  const { SimpleBox } = await import("@boxlite-ai/boxlite");
  const image = config?.image ?? DEFAULT_IMAGE;
  const memoryMib = config?.memoryMib ?? DEFAULT_MEMORY_MIB;
  const cpus = config?.cpus ?? DEFAULT_CPUS;
  const workingDir = config?.workdir ?? DEFAULT_WORKDIR;

  const box = new SimpleBox({
    image,
    memoryMib,
    cpus,
    workingDir,
    env: config?.env,
    name: scopeKey,
    reuseExisting: true,
  });

  const handle: BoxHandle = {
    async run(cmd: string, ...args: string[]) {
      const result = await box.exec(cmd, ...args);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    async copyIn(hostPath: string, containerDest: string) {
      await box.copyIn(hostPath, containerDest);
    },
    async copyOut(containerSrc: string, hostDest: string) {
      await box.copyOut(containerSrc, hostDest);
    },
    async stop() {
      await box.stop();
    },
  };

  // Register before setup so the VM is always reachable for cleanup.
  const entry: BoxEntry = {
    handle,
    createdAtMs: Date.now(),
    lastUsedAtMs: Date.now(),
  };
  activeBoxes.set(scopeKey, entry);

  // Run setup command if configured.
  if (config?.setupCommand?.trim()) {
    let setupError: Error | undefined;
    try {
      const setupResult = await handle.run("sh", "-c", config.setupCommand);
      if (setupResult.exitCode !== 0) {
        const detail = setupResult.stderr?.trim() || setupResult.stdout?.trim() || "";
        setupError = new Error(
          `BoxLite setup command failed with exit code ${setupResult.exitCode}${detail ? `: ${detail}` : ""}`,
        );
      }
    } catch (err) {
      setupError = err instanceof Error ? err : new Error(String(err));
    }
    if (setupError) {
      activeBoxes.delete(scopeKey);
      await handle.stop().catch(() => undefined);
      throw setupError;
    }
  }

  return handle;
}

export async function runBoxLiteCommand(
  scopeKey: string,
  cmd: string,
  args: string[],
): Promise<BoxLiteExecResult> {
  const entry = activeBoxes.get(scopeKey);
  if (!entry) {
    throw new Error(`BoxLite box not found for scope key: ${scopeKey}`);
  }
  entry.lastUsedAtMs = Date.now();
  return entry.handle.run(cmd, ...args);
}

export async function stopBoxLiteBox(scopeKey: string): Promise<void> {
  const entry = activeBoxes.get(scopeKey);
  if (!entry) {
    return;
  }
  activeBoxes.delete(scopeKey);
  try {
    await entry.handle.stop();
  } catch {
    // Best-effort cleanup.
  }
}

export async function stopAllBoxLiteBoxes(): Promise<void> {
  const keys = [...activeBoxes.keys()];
  for (const key of keys) {
    await stopBoxLiteBox(key);
  }
}

export function getActiveBoxLiteBoxCount(): number {
  return activeBoxes.size;
}

export function resolveBoxLiteWorkdir(config?: BoxLiteSettings): string {
  return config?.workdir ?? DEFAULT_WORKDIR;
}
