import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createVacuumedSqliteSnapshot,
  verifySqliteDatabaseIntegrity,
} from "@openclaw/memory-host-sdk/engine-storage";
import {
  buildSnapshotArtifact,
  readSnapshotManifest,
  sha256File,
  writeSnapshotManifest,
} from "./manifest.js";
import {
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotDatabaseRef,
  type SnapshotManifest,
  type SnapshotRef,
  type SnapshotResult,
  type SnapshotSummary,
  type SnapshotVerificationResult,
  type SqliteSnapshotProvider,
} from "./snapshot-provider.js";

export type LocalSqliteSnapshotProviderOptions = {
  readonly repositoryPath: string;
  readonly now?: () => Date;
};

export function createLocalSqliteSnapshotProvider(
  options: LocalSqliteSnapshotProviderOptions,
): SqliteSnapshotProvider {
  return new LocalSqliteSnapshotProvider(options);
}

class LocalSqliteSnapshotProvider implements SqliteSnapshotProvider {
  readonly #repositoryPath: string;
  readonly #now: () => Date;

  constructor(options: LocalSqliteSnapshotProviderOptions) {
    this.#repositoryPath = path.resolve(options.repositoryPath);
    this.#now = options.now ?? (() => new Date());
  }

  async create(dbRef: SnapshotDatabaseRef): Promise<SnapshotResult> {
    const sourcePath = path.resolve(dbRef.path);
    const now = this.#now();
    const snapshotId = buildSnapshotId(now, sourcePath, randomUUID());
    const snapshotDir = path.join(this.#repositoryPath, snapshotId);
    const stagingDir = path.join(this.#repositoryPath, `.tmp-${snapshotId}-${randomUUID()}`);
    const artifactPath = path.join(stagingDir, SNAPSHOT_SQLITE_FILENAME);
    await fs.mkdir(this.#repositoryPath, { recursive: true });
    await fs.mkdir(stagingDir, { recursive: false });
    try {
      const { userVersion } = await createVacuumedSqliteSnapshot({
        sourcePath,
        targetPath: artifactPath,
      });
      const manifest: SnapshotManifest = {
        schemaVersion: 1,
        snapshotId,
        createdAt: now.toISOString(),
        database: {
          id: dbRef.id ?? path.basename(sourcePath),
          ...(dbRef.kind ? { kind: dbRef.kind } : {}),
          basename: path.basename(sourcePath),
          userVersion,
        },
        artifact: await buildSnapshotArtifact(stagingDir, artifactPath),
      };
      await writeSnapshotManifest(stagingDir, manifest);
      await fs.rename(stagingDir, snapshotDir);
      return { ref: { path: snapshotDir }, manifest };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  async verify(snapshotRef: SnapshotRef): Promise<SnapshotVerificationResult> {
    const snapshotDir = path.resolve(snapshotRef.path);
    const manifest = await readSnapshotManifest(snapshotDir);
    const artifactPath = path.join(snapshotDir, manifest.artifact.path);
    const stat = await fs.stat(artifactPath);
    if (stat.size !== manifest.artifact.sizeBytes) {
      throw new Error(
        `Snapshot artifact size mismatch for ${artifactPath}: expected ${manifest.artifact.sizeBytes}, got ${stat.size}`,
      );
    }
    const actualHash = await sha256File(artifactPath);
    if (actualHash !== manifest.artifact.sha256) {
      throw new Error(
        `Snapshot artifact hash mismatch for ${artifactPath}: expected ${manifest.artifact.sha256}, got ${actualHash}`,
      );
    }
    const integrityCheck = verifySqliteDatabaseIntegrity(artifactPath);
    return { ok: true, manifest, integrityCheck };
  }

  async restore(snapshotRef: SnapshotRef, targetPath: string): Promise<SnapshotVerificationResult> {
    const verified = await this.verify(snapshotRef);
    const snapshotDir = path.resolve(snapshotRef.path);
    const sourcePath = path.join(snapshotDir, verified.manifest.artifact.path);
    const resolvedTargetPath = path.resolve(targetPath);
    await fs.mkdir(path.dirname(resolvedTargetPath), { recursive: true });
    await fs.copyFile(sourcePath, resolvedTargetPath, fs.constants.COPYFILE_EXCL);
    await removeSqliteSidecars(resolvedTargetPath);
    await fs.chmod(resolvedTargetPath, 0o600);
    verifySqliteDatabaseIntegrity(resolvedTargetPath);
    return verified;
  }

  async list(): Promise<SnapshotSummary[]> {
    const entries = await fs
      .readdir(this.#repositoryPath, { withFileTypes: true })
      .catch((error: unknown) => {
        if (isNodeErrorCode(error, "ENOENT")) {
          return [];
        }
        throw error;
      });
    const snapshots: SnapshotSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".tmp-")) {
        continue;
      }
      const snapshotPath = path.join(this.#repositoryPath, entry.name);
      snapshots.push({
        ref: { path: snapshotPath },
        manifest: await readSnapshotManifest(snapshotPath),
      });
    }
    return snapshots.toSorted((left, right) =>
      left.manifest.createdAt.localeCompare(right.manifest.createdAt),
    );
  }
}

function buildSnapshotId(now: Date, sourcePath: string, suffix: string): string {
  const timestamp = now.toISOString().replaceAll(/[:.]/g, "-");
  const basename = path.basename(sourcePath).replaceAll(/[^a-zA-Z0-9._-]/g, "-");
  return `${timestamp}-${basename}-${suffix}`;
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await Promise.all([
    fs.rm(`${databasePath}-wal`, { force: true }),
    fs.rm(`${databasePath}-shm`, { force: true }),
  ]);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === code
  );
}
