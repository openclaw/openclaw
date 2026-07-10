import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { loadMatrixQaE2eeRuntime } from "../substrate/e2ee-client.js";
import type { createMatrixQaOpenClawCliRuntime } from "./scenario-runtime-cli.js";

type MatrixQaCliRuntime = Awaited<ReturnType<typeof createMatrixQaOpenClawCliRuntime>>;

type MatrixQaStorageMetadataRuntime = Pick<
  Awaited<ReturnType<typeof loadMatrixQaE2eeRuntime>>,
  "normalizeMatrixStorageMetadata" | "openMatrixStorageMetaStoreOptions"
>;

async function findFilesByName(params: { filename: string; rootDir: string }): Promise<string[]> {
  const matches: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 10) {
      return;
    }
    let entries: Array<{
      isDirectory(): boolean;
      isFile(): boolean;
      name: string;
    }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === params.filename) {
        matches.push(entryPath);
      } else if (entry.isDirectory()) {
        await visit(entryPath, depth + 1);
      }
    }
  }
  await visit(params.rootDir, 0);
  return matches.toSorted();
}

export async function findMatrixQaCliAccountRoot(params: {
  deviceId: string;
  runtime: Pick<MatrixQaCliRuntime, "stateDir">;
  storageMetadataRuntime?: MatrixQaStorageMetadataRuntime;
  userId: string;
}) {
  const storageMetadataRuntime = params.storageMetadataRuntime ?? (await loadMatrixQaE2eeRuntime());
  const sqlitePaths = await findFilesByName({
    filename: "openclaw.sqlite",
    rootDir: params.runtime.stateDir,
  });
  const legacyMetadataPaths = await findFilesByName({
    filename: "storage-meta.json",
    rootDir: params.runtime.stateDir,
  });
  // Current account metadata lives in account-local SQLite. Keep legacy JSON
  // discovery for older tagged fixtures without making it the canonical path.
  const accountRoots = new Set(
    sqlitePaths
      .filter((sqlitePath) => path.basename(path.dirname(sqlitePath)) === "state")
      .map((sqlitePath) => path.dirname(path.dirname(sqlitePath))),
  );
  for (const metadataPath of legacyMetadataPaths) {
    accountRoots.add(path.dirname(metadataPath));
  }
  for (const accountRoot of [...accountRoots].toSorted()) {
    let metadata: { deviceId?: unknown; userId?: unknown } | null = null;
    try {
      await access(path.join(accountRoot, "state", "openclaw.sqlite"));
      try {
        const store = createPluginStateSyncKeyedStoreForTests<unknown>(
          "matrix",
          storageMetadataRuntime.openMatrixStorageMetaStoreOptions(accountRoot),
        );
        metadata = storageMetadataRuntime.normalizeMatrixStorageMetadata(store.lookup("current"));
      } finally {
        resetPluginStateStoreForTests();
      }
    } catch {
      // Fall through to the legacy sidecar for pre-SQLite fixtures.
    }
    if (!metadata) {
      try {
        metadata = JSON.parse(
          await readFile(path.join(accountRoot, "storage-meta.json"), "utf8"),
        ) as {
          deviceId?: unknown;
          userId?: unknown;
        };
      } catch {
        continue;
      }
    }
    if (metadata.userId === params.userId && metadata.deviceId === params.deviceId) {
      return accountRoot;
    }
  }
  throw new Error(`Matrix CLI account storage root was not created for ${params.userId}`);
}
