export interface PnpmRunnerParams {
  comSpec?: string;
<<<<<<< HEAD
  cwd?: string;
  env?: NodeJS.ProcessEnv;
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  nodeArgs?: string[];
  nodeExecPath?: string;
  npmExecPath?: string;
  platform?: string;
  pnpmArgs?: string[];
}

export interface PnpmRunnerSpec {
  args: string[];
  command: string;
  shell: false;
  windowsVerbatimArguments?: true;
}

export function resolvePnpmRunner(params?: PnpmRunnerParams): PnpmRunnerSpec;
