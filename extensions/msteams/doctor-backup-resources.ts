import path from "node:path";
import type { PluginDoctorMigrationBackupResource } from "openclaw/plugin-sdk/runtime-doctor-migrations";

export function stateFileArchiveDirectory(filePath: string): string {
  return `${filePath}.archives`;
}

export function stateFileBackupResources(
  stateDir: string,
  filename: string,
): PluginDoctorMigrationBackupResource[] {
  const filePath = path.join(stateDir, filename);
  // Every collision suffix stays inside this directory; unrelated state and code
  // links must not become migration data merely because the token shares a parent.
  return [
    { path: filePath, kind: "file" },
    { path: stateFileArchiveDirectory(filePath), kind: "directory" },
  ];
}
