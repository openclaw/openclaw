import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export function loadWorkspaceDotEnvForExec(params: {
  workspaceDir?: string;
  baseEnv?: Record<string, string>;
}): Record<string, string> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return {};
  }

  const envPath = path.join(workspaceDir, ".env");
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const parsed = dotenv.parse(fs.readFileSync(envPath, "utf-8"));
  const baseEnv = params.baseEnv ?? {};
  const injected: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    // Match dotenv semantics used at startup: never override already-defined vars.
    if (typeof baseEnv[key] === "string") {
      continue;
    }
    injected[key] = value;
  }
  return injected;
}
