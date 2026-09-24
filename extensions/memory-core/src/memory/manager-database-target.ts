// Resolve and open the single published database target owned by a memory manager.
import {
  resolveStateDir,
  resolveUserPath,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  MemoryIndexDatabase,
  type MemoryDatabaseWriteOptions,
} from "./manager-database-context.js";
import {
  acquireSharedMemoryDatabase,
  resolveSharedMemoryIndexScope,
  type SharedMemoryIndexScope,
} from "./manager-shared-database.js";

export type MemoryIndexDatabaseTarget =
  | {
      kind: "agent";
      path: string;
      writeOptions: MemoryDatabaseWriteOptions;
    }
  | {
      kind: "shared";
      path: string;
      scope: SharedMemoryIndexScope;
    };

export function captureMemoryIndexDatabaseWriteOptions(
  agentId: string,
  databasePath: string,
  source?: MemoryIndexDatabase,
): MemoryDatabaseWriteOptions {
  const env = { ...(source?.writeOptions?.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  return {
    agentId,
    path: source?.writeOptions?.path ?? resolveUserPath(databasePath),
    env,
  };
}

export function resolveMemoryIndexDatabaseTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  settings: ResolvedMemorySearchConfig;
  workspaceDir: string;
  agentDatabaseOptions: MemoryDatabaseWriteOptions;
  maintenanceSourceTarget?: MemoryIndexDatabaseTarget;
}): MemoryIndexDatabaseTarget {
  const sharedScope = resolveSharedMemoryIndexScope({
    cfg: params.cfg,
    agentId: params.agentId,
    settings: params.settings,
    workspaceDir: params.workspaceDir,
  });
  const target: MemoryIndexDatabaseTarget = sharedScope
    ? { kind: "shared", path: sharedScope.path, scope: sharedScope }
    : {
        kind: "agent",
        path: params.agentDatabaseOptions.path,
        writeOptions: params.agentDatabaseOptions,
      };
  if (
    params.maintenanceSourceTarget &&
    (params.maintenanceSourceTarget.kind !== target.kind ||
      params.maintenanceSourceTarget.path !== target.path)
  ) {
    throw new Error("Memory maintenance source sharing changed");
  }
  return target;
}

export function openMemoryIndexPublishedDatabase(params: {
  agentId: string;
  databaseTarget: MemoryIndexDatabaseTarget;
  readOnly: boolean;
  allowExtension: boolean;
  maintenanceSource?: MemoryIndexDatabase;
}): MemoryIndexDatabase {
  return MemoryIndexDatabase.openPublished({
    agentId: params.agentId,
    ...(params.databaseTarget.kind === "agent"
      ? { writeOptions: params.databaseTarget.writeOptions }
      : {
          sharedDatabase: acquireSharedMemoryDatabase({
            allowExtension: params.allowExtension,
            readOnly: params.readOnly,
            scope: params.databaseTarget.scope,
          }),
        }),
    readOnly: params.readOnly,
    allowExtension: params.allowExtension,
    maintenanceSource: params.maintenanceSource,
  });
}
