import fs from "node:fs/promises";
import path from "node:path";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";

type AuthJsonCredential =
  | {
      type: "api_key";
      key: string;
    }
  | {
      type: "oauth";
      access: string;
      refresh: string;
      expires: number;
      [key: string]: unknown;
    };

type AuthJsonShape = Record<string, AuthJsonCredential>;

async function readAuthJson(filePath: string): Promise<AuthJsonShape> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as AuthJsonShape;
  } catch {
    return {};
  }
}

/**
 * pi-coding-agent's ModelRegistry/AuthStorage expects OAuth credentials in auth.json.
 *
 * OpenClaw stores OAuth credentials in auth-profiles.json instead. This helper
 * bridges a subset of credentials into agentDir/auth.json so pi-coding-agent can
 * (a) consider the provider authenticated and (b) include built-in models in its
 * registry/catalog output.
 *
 * Currently used for openai-codex.
 */
export async function ensurePiAuthJsonFromAuthProfiles(agentDir: string): Promise<{
  wrote: boolean;
  authPath: string;
}> {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const codexProfiles = listProfilesForProvider(store, "openai-codex");
  if (codexProfiles.length === 0) {
    return { wrote: false, authPath: path.join(agentDir, "auth.json") };
  }

  const profileId = codexProfiles[0];
  const cred = profileId ? store.profiles[profileId] : undefined;
  if (!cred || cred.type !== "oauth") {
    return { wrote: false, authPath: path.join(agentDir, "auth.json") };
  }

  const accessRaw = (cred as { access?: unknown }).access;
  const refreshRaw = (cred as { refresh?: unknown }).refresh;
  const expiresRaw = (cred as { expires?: unknown }).expires;

  const access = typeof accessRaw === "string" ? accessRaw.trim() : "";
  const refresh = typeof refreshRaw === "string" ? refreshRaw.trim() : "";
  const expires = typeof expiresRaw === "number" ? expiresRaw : Number.NaN;

  if (!access || !refresh || !Number.isFinite(expires) || expires <= 0) {
    return { wrote: false, authPath: path.join(agentDir, "auth.json") };
  }

  const authPath = path.join(agentDir, "auth.json");
  const next = await readAuthJson(authPath);

  const existing = next["openai-codex"];
  const desired: AuthJsonCredential = {
    type: "oauth",
    access,
    refresh,
    expires,
  };

  const isSame =
    existing &&
    typeof existing === "object" &&
    (existing as { type?: unknown }).type === "oauth" &&
    (existing as { access?: unknown }).access === access &&
    (existing as { refresh?: unknown }).refresh === refresh &&
    (existing as { expires?: unknown }).expires === expires;

  if (isSame) {
    return { wrote: false, authPath };
  }

  next["openai-codex"] = desired;

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(authPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });

  return { wrote: true, authPath };
}
