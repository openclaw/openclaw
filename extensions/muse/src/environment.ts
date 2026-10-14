import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export async function museEnvironment(
  apiKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const inherited = { ...process.env, ...env };
  const managedHome = path.join(resolveStateDir(inherited), "muse");
  let managed = true;
  try {
    await fs.access(path.join(managedHome, "muse", "auth.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      managed = false;
    } else {
      throw error;
    }
  }
  // An existing managed store remains authoritative even if its contents are unusable.
  return {
    ...inherited,
    MUSE_NO_AUTO_UPDATE: "1",
    ...(managed ? { TBH_CREDENTIAL_BACKEND: "file", XDG_CONFIG_HOME: managedHome } : {}),
    ...(apiKey ? { META_API_KEY: apiKey } : {}),
  };
}
