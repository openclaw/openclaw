export type StandaloneRuntimeManifest = {
  schemaVersion: 1;
  mode: "jit" | "bytecode" | "aot";
  executable: { path: string };
  runtime: { path: string };
  openclaw: { version: string };
  bun: { version: string };
};

export function readStandaloneRuntimeManifest(
  executable?: string,
): StandaloneRuntimeManifest | undefined;
export function isStandaloneRuntimeExecutable(executable?: string): boolean;
export function getEmbeddedStandaloneRuntimeRoot(): string | undefined;
export function resolveOpenClawCliInvocation(params?: {
  execPath?: string;
  /** Null selects an executable CLI command without inheriting the current script. */
  entryPath?: string | null;
  args?: readonly string[];
  execArgv?: readonly string[];
}): { command: string; args: string[] };
