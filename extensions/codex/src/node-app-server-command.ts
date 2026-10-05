/** Exact command identity fences a placement to its enrolled model configuration. */
import fs from "node:fs";
import path from "node:path";

const PREFIX = "codex.app-server.stdio.v1";

export function resolveCodexWorkerAppServerCommand(
  env: NodeJS.ProcessEnv = process.env,
  required = false,
): string {
  const configured = env.FACTORY_WORKER_LLM_CONFIG_VERSION;
  let enrolled: string | undefined;
  if (env.OPENCLAW_STATE_DIR) {
    try {
      enrolled = fs.readFileSync(
        path.join(env.OPENCLAW_STATE_DIR, "codex-runtime", "version"),
        "utf8",
      );
    } catch {
      /* Gateway and other nodes have no worker lease config. */
    }
  }
  const version = enrolled ?? configured;
  if (!version) {
    if (required) {
      throw new Error("Worker Codex configuration version is unavailable");
    }
    return PREFIX;
  }
  if (!/^[a-f0-9]{64}$/.test(version) || (enrolled && configured && enrolled !== configured)) {
    throw new Error("Worker Codex configuration version is invalid or mismatched");
  }
  return `${PREFIX}.${version}`;
}
