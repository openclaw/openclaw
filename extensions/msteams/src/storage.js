import path from "node:path";
import { getMSTeamsRuntime } from "./runtime.js";
function resolveMSTeamsStorePath(params) {
  if (params.storePath) {
    return params.storePath;
  }
  if (params.stateDir) {
    return path.join(params.stateDir, params.filename);
  }
  const env = params.env ?? process.env;
  const stateDir = params.homedir ? getMSTeamsRuntime().state.resolveStateDir(env, params.homedir) : getMSTeamsRuntime().state.resolveStateDir(env);
  return path.join(stateDir, params.filename);
}
export {
  resolveMSTeamsStorePath
};
