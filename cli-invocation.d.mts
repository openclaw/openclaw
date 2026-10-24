export type StandaloneBuildInfo = {
  mode: "jit" | "bytecode" | "aot";
  openclaw: { version: string; commit?: string };
  bun: { version: string; revision?: string; commit?: string; executableSha256?: string };
  target?: { platform: string; arch: string };
  build?: {
    id: string;
    flavor: "standard" | "support";
    pluginSetSha256: string;
    moduleGraphSha256: string;
    debugEntry?: string;
  };
  plugins?: { embedded: string[]; omitted: string[] };
  nativeModules?: {
    name: string;
    version: string;
    artifacts: string[];
    qualification: "unverified";
    backend: string;
  }[];
};

export type StandaloneRuntimeManifest = StandaloneBuildInfo & {
  schemaVersion: 1;
  executable: { path: string; sha256?: string };
  runtime: { path: string; sha256?: string };
};

export function getStandaloneRuntimeBuild(executable?: string): StandaloneBuildInfo | undefined;

export function readStandaloneRuntimeManifest(
  executable?: string,
): StandaloneRuntimeManifest | undefined;
export function readStandaloneRuntimeManifestForRoot(
  runtimeRoot: string,
): StandaloneRuntimeManifest | undefined;
export function isStandaloneRuntimeExecutable(executable?: string): boolean;
export function getEmbeddedStandaloneRuntimeRoot(): string | undefined;
export function isEmbeddedStandaloneModule(modulePath: string): boolean;
export function runtimeHasSourceLoader(): boolean;
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
