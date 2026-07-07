// Narrow IO/runtime facade re-exported for memory host helpers.

export {
  CHARS_PER_TOKEN_ESTIMATE,
  configureSqliteConnectionPragmas,
  configureSqliteWalMaintenance,
  root,
  createSubsystemLogger,
  detectMime,
  estimateStringChars,
  installProcessWarningFilter,
  materializeWindowsSpawnProgram,
  redactSensitiveText,
  resolveGlobalSingleton,
  resolveUserPath,
  resolveWindowsSpawnProgram,
  runTasksWithConcurrency,
  shortenHomeInString,
  shortenHomePath,
  splitShellArgs,
  truncateUtf16Safe,
} from "./openclaw-runtime.js";

export type {
  ResolveWindowsSpawnProgramParams,
  SqliteConnectionPragmaOptions,
  SqliteWalMaintenance,
  SqliteWalMaintenanceOptions,
  WindowsSpawnInvocation,
  WindowsSpawnProgram,
} from "./openclaw-runtime.js";
