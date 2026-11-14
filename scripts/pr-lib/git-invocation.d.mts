export declare function bindGitInvocation(
  directory: string | undefined,
  selectedGit: string,
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): { executable: string; env: NodeJS.ProcessEnv };
