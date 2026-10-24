export type StandaloneRuntimeManifest = {
  schemaVersion: 1;
  mode: "jit" | "bytecode" | "aot";
  executable: { path: string; sha256?: string };
  runtime: { path: string; sha256?: string };
  openclaw: { version: string; commit?: string };
  bun: { version: string };
};

export function readStandaloneRuntimeManifest(
  executable?: string,
): StandaloneRuntimeManifest | undefined;
export function readStandaloneRuntimeManifestForRoot(
  runtimeRoot: string,
): StandaloneRuntimeManifest | undefined;
export function isStandaloneRuntimeExecutable(executable?: string): boolean;
export function getEmbeddedStandaloneRuntimeRoot(): string | undefined;
export function resolveStandaloneNpmCliPath(): string | undefined;
export function resolveRuntimeScriptEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function resolveOpenClawCliInvocation(params?: {
  execPath?: string;
  /** Null selects an executable CLI command without inheriting the current script. */
  entryPath?: string | null;
  args?: readonly string[];
  execArgv?: readonly string[];
}): { command: string; args: string[] };

export function resolveOpenClawCliRespawn(params?: {
  execPath?: string;
  entryPath?: string | null;
  args?: readonly string[];
  execArgv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): { command: string; args: string[]; env: NodeJS.ProcessEnv };
