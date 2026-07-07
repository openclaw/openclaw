// Narrow IO/runtime facade re-exported for memory host helpers.

export {
  CHARS_PER_TOKEN_ESTIMATE,
  applyWindowsSpawnProgramPolicy,
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
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
  runTasksWithConcurrency,
  shortenHomeInString,
  shortenHomePath,
  splitShellArgs,
  truncateUtf16Safe,
} from "./openclaw-runtime.js";

export type {
  ResolveWindowsSpawnProgramCandidateParams,
  ResolveWindowsSpawnProgramParams,
  SqliteConnectionPragmaOptions,
  SqliteWalMaintenance,
  SqliteWalMaintenanceOptions,
  WindowsSpawnCandidateResolution,
  WindowsSpawnInvocation,
  WindowsSpawnProgram,
  WindowsSpawnProgramCandidate,
  WindowsSpawnResolution,
} from "./openclaw-runtime.js";
