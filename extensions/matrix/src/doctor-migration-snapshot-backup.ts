import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveRequiredHomeDir, resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const MATRIX_MIGRATION_SNAPSHOT_DIRNAME = "openclaw-migrations";
const MATRIX_MIGRATION_SNAPSHOT_NAMESPACE = "migration-snapshot";
const MATRIX_MIGRATION_SNAPSHOT_KEY = "current";

type MatrixMigrationSnapshotMarker = {
  version: 1;
  createdAt: string;
  archivePath: string;
  trigger: string;
  includeWorkspace: boolean;
};

type MatrixMigrationSnapshotResult = {
  created: boolean;
  archivePath: string;
  markerKey: string;
};

const snapshotMarkerStore = createPluginStateKeyedStore<MatrixMigrationSnapshotMarker>("matrix", {
  namespace: MATRIX_MIGRATION_SNAPSHOT_NAMESPACE,
  maxEntries: 1,
});

function isMatrixMigrationSnapshotMarker(value: unknown): value is MatrixMigrationSnapshotMarker {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as Partial<MatrixMigrationSnapshotMarker>).version === 1 &&
    typeof (value as Partial<MatrixMigrationSnapshotMarker>).createdAt === "string" &&
    typeof (value as Partial<MatrixMigrationSnapshotMarker>).archivePath === "string" &&
    typeof (value as Partial<MatrixMigrationSnapshotMarker>).trigger === "string"
  );
}

async function loadSnapshotMarker(
  env: NodeJS.ProcessEnv,
): Promise<MatrixMigrationSnapshotMarker | null> {
  const value = await withSnapshotStateEnv(env, async () =>
    snapshotMarkerStore.lookup(MATRIX_MIGRATION_SNAPSHOT_KEY),
  );
  return isMatrixMigrationSnapshotMarker(value) ? value : null;
}

async function writeSnapshotMarker(
  env: NodeJS.ProcessEnv,
  marker: MatrixMigrationSnapshotMarker,
): Promise<void> {
  await withSnapshotStateEnv(env, async () =>
    snapshotMarkerStore.register(MATRIX_MIGRATION_SNAPSHOT_KEY, marker),
  );
}

async function withSnapshotStateEnv<T>(
  env: NodeJS.ProcessEnv,
  action: () => Promise<T>,
): Promise<T> {
  const stateDir = resolveStateDir(env, os.homedir);
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    return await action();
  } finally {
    if (previous == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

export function resolveMatrixMigrationSnapshotOutputDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const homeDir = resolveRequiredHomeDir(env, os.homedir);
  return path.join(homeDir, "Backups", MATRIX_MIGRATION_SNAPSHOT_DIRNAME);
}

export async function maybeCreateMatrixMigrationSnapshot(params: {
  trigger: string;
  env?: NodeJS.ProcessEnv;
  outputDir?: string;
  createBackupArchive?: typeof import("openclaw/plugin-sdk/runtime").createBackupArchive;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<MatrixMigrationSnapshotResult> {
  const env = params.env ?? process.env;
  const createBackupArchive =
    params.createBackupArchive ?? (await import("openclaw/plugin-sdk/runtime")).createBackupArchive;
  const existingMarker = await loadSnapshotMarker(env);
  if (existingMarker?.archivePath && fs.existsSync(existingMarker.archivePath)) {
    params.log?.info?.(
      `matrix: reusing existing pre-migration backup snapshot: ${existingMarker.archivePath}`,
    );
    return {
      created: false,
      archivePath: existingMarker.archivePath,
      markerKey: MATRIX_MIGRATION_SNAPSHOT_KEY,
    };
  }
  if (existingMarker?.archivePath && !fs.existsSync(existingMarker.archivePath)) {
    params.log?.warn?.(
      `matrix: previous migration snapshot is missing (${existingMarker.archivePath}); creating a replacement backup before continuing`,
    );
  }

  const snapshot = await createBackupArchive({
    output: (() => {
      const outputDir = params.outputDir ?? resolveMatrixMigrationSnapshotOutputDir(env);
      fs.mkdirSync(outputDir, { recursive: true });
      return outputDir;
    })(),
    includeWorkspace: false,
  });

  const marker: MatrixMigrationSnapshotMarker = {
    version: 1,
    createdAt: snapshot.createdAt,
    archivePath: snapshot.archivePath,
    trigger: params.trigger,
    includeWorkspace: snapshot.includeWorkspace,
  };
  await writeSnapshotMarker(env, marker);
  params.log?.info?.(`matrix: created pre-migration backup snapshot: ${snapshot.archivePath}`);
  return {
    created: true,
    archivePath: snapshot.archivePath,
    markerKey: MATRIX_MIGRATION_SNAPSHOT_KEY,
  };
}
