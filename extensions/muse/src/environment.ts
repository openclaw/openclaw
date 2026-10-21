import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export async function museEnvironment(
  apiKey?: string,
): Promise<{ env: NodeJS.ProcessEnv; credentialSource: string }> {
  const inherited = { ...process.env };
  const managedHome = path.join(resolveStateDir(inherited), "muse");
  const authPath = path.join(managedHome, "muse", "auth.json");
  let credentialSource: string;
  try {
    const stat = await fs.stat(authPath);
    credentialSource = JSON.stringify([
      "managed",
      authPath,
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      credentialSource = "native";
    } else {
      throw error;
    }
  }
  // An existing managed store remains authoritative even if its contents are unusable.
  return {
    credentialSource,
    env: {
      ...inherited,
      MUSE_NO_AUTO_UPDATE: "1",
      ...(credentialSource !== "native"
        ? { TBH_CREDENTIAL_BACKEND: "file", XDG_CONFIG_HOME: managedHome }
        : {}),
      ...(apiKey ? { META_API_KEY: apiKey } : {}),
    },
  };
}
