import path from "node:path";
import { getMSTeamsRuntime } from "./runtime.js";

type MSTeamsCredentialPathOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  pathOverride?: string;
  filename: string;
};

export function resolveMSTeamsCredentialFilePath(params: MSTeamsCredentialPathOptions): string {
  if (params.pathOverride) {
    return params.pathOverride;
  }
  if (params.stateDir) {
    return path.join(params.stateDir, params.filename);
  }

  const env = params.env ?? process.env;
  const stateDir = params.homedir
    ? getMSTeamsRuntime().state.resolveStateDir(env, params.homedir)
    : getMSTeamsRuntime().state.resolveStateDir(env);
  return path.join(stateDir, params.filename);
}
