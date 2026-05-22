//#region src/entry.d.ts
declare function tryHandleRootHelpFastPath(argv: string[], deps?: {
  outputPrecomputedRootHelpText?: () => boolean;
  outputRootHelp?: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean>;
//#endregion
export { tryHandleRootHelpFastPath };