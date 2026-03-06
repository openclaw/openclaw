import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

export async function loadWorkspaceDotEnvForExec(params: {
  workspaceDir?: string;
  baseEnv?: Record<string, string>;
}): Promise<Record<string, string>> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return {};
  }

  const envPath = path.join(workspaceDir, ".env");
  let envRaw: string;
  try {
    envRaw = await fs.readFile(envPath, "utf-8");
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: string }).code)
        : "";
    if (
      code === "ENOENT" ||
      code === "EACCES" ||
      code === "EPERM" ||
      code === "ENOTDIR" ||
      code === "EISDIR"
    ) {
      return {};
    }
    throw error;
  }

  const parsed = dotenv.parse(envRaw);
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
