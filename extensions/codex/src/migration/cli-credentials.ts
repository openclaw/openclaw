/** Explicit migration reads the storage selected by the native credential owner. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { readSecretFile } from "openclaw/plugin-sdk/secret-file";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerClient } from "../app-server/client.js";
import type { CodexExperimentalFeatureListResponse } from "../app-server/protocol-control-plane.js";
import type {
  CodexConfigReadResponse,
  CodexConfigRequirementsReadResponse,
  CodexGetAccountResponse,
} from "../app-server/protocol.js";

export type CodexCliCredential = {
  type: "oauth";
  provider: "openai";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  idToken?: string;
};

type CodexCliApiKeyCredential = { type: "api_key"; provider: "openai"; key: string };
export type CodexCliCredentials = {
  oauth?: CodexCliCredential;
  apiKey?: CodexCliApiKeyCredential;
};
export type CodexCredentialReadOptions = {
  codexHome: string;
  allowKeychainPrompt: boolean;
  credentialKind?: "oauth" | "api_key";
  signal?: AbortSignal;
};

async function readAuthFile(home: string): Promise<Record<string, unknown> | undefined> {
  try {
    return asOptionalRecord(
      JSON.parse(await readSecretFile(path.join(home, "auth.json"), "Codex auth")),
    );
  } catch {
    return undefined;
  }
}

async function readDirectKeyring(
  home: string,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const account = `cli|${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
  const result = await runCommandBuffered(
    ["security", "find-generic-password", "-s", "Codex Auth", "-a", account, "-w"],
    { timeoutMs: 60_000, maxCombinedOutputBytes: 16 * 1024, signal },
  );
  if (result.termination !== "exit" || result.code !== 0) {
    return undefined;
  }
  try {
    return asOptionalRecord(JSON.parse(result.stdout.toString("utf8")));
  } catch {
    return undefined;
  }
}

export async function readCodexCliCredentialsAsync(
  options: CodexCredentialReadOptions,
): Promise<CodexCliCredentials | undefined> {
  options.signal?.throwIfAborted();
  // Native startup loads auth before config/read can identify the selected storage.
  if (!options.allowKeychainPrompt) {
    return undefined;
  }
  const home = await fs.realpath(options.codexHome).catch(() => path.resolve(options.codexHome));
  const { CodexAppServerClient } = await import("../app-server/client.js");
  const { resolveManagedCodexPackageEntrypoint, resolveManagedCodexNativeCommand } =
    await import("../app-server/managed-binary.js");
  const launcher = resolveManagedCodexPackageEntrypoint(
    path.dirname(fileURLToPath(import.meta.url)),
  );
  const command = launcher ? resolveManagedCodexNativeCommand(launcher) : undefined;
  if (!command) {
    return undefined;
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(process.platform === "darwin" ? 60_000 : 5_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const client = await CodexAppServerClient.start(
    {
      transport: "stdio",
      command,
      commandSource: "resolved-managed",
      args: ["app-server"],
      cwd: home,
      homeScope: "user",
      env: { CODEX_HOME: home },
      clearEnv: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
    },
    () => signal.throwIfAborted(),
  ).catch(() => {
    options.signal?.throwIfAborted();
    return undefined;
  });
  if (!client) {
    return undefined;
  }
  const abort = () => client.close();
  signal.addEventListener("abort", abort, { once: true });
  let credential: CodexCliCredentials | undefined;
  try {
    credential = await readNativeCredential(client, home, options, signal);
  } catch {
    // Unsupported or unavailable native storage leaves interactive sign-in available.
  }
  signal.removeEventListener("abort", abort);
  // 2026-09-09: the pinned native reader took five seconds to exit after replying.
  const closed = await client.closeAndWait({ forceKillDelayMs: 6_000, exitTimeoutMs: 7_000 });
  if (!closed.exited || closed.cleanup !== "closed") {
    throw new Error("The Codex credential reader could not stop. No credential was imported.", {
      cause: options.signal?.reason,
    });
  }
  options.signal?.throwIfAborted();
  return credential;
}

async function readNativeCredential(
  client: CodexAppServerClient,
  home: string,
  options: CodexCredentialReadOptions,
  signal: AbortSignal,
): Promise<CodexCliCredentials | undefined> {
  signal.throwIfAborted();
  await client.initialize();
  if (client.getRuntimeIdentity()?.codexHome !== home) {
    return undefined;
  }
  const revision = client.getModelCatalogRevision();
  const configured = await client.request<CodexConfigReadResponse>(
    "config/read",
    { includeLayers: false, cwd: home },
    { signal },
  );
  const required = await client.request<CodexConfigRequirementsReadResponse>(
    "configRequirements/read",
    {},
    { signal },
  );
  // The native requirements override configuration; File is the pinned dependency's default.
  const mode =
    required.requirements?.cli_auth_credentials_store ??
    configured.config.cli_auth_credentials_store ??
    "file";
  let record: Record<string, unknown> | undefined;
  if (mode === "file") {
    record = await readAuthFile(home);
  } else if ((mode === "keyring" || mode === "auto") && process.platform === "darwin") {
    let cursor: string | undefined;
    let encrypted: boolean | undefined;
    do {
      const features = await client.request<CodexExperimentalFeatureListResponse>(
        "experimentalFeature/list",
        { limit: 100, cursor },
        { signal },
      );
      const storage = features.data.find((feature) => feature.name === "secret_auth_storage");
      if (storage) {
        encrypted = storage.enabled;
        break;
      }
      cursor = features.nextCursor ?? undefined;
    } while (cursor);
    if (encrypted !== false) {
      return undefined;
    }
    record = await readDirectKeyring(home, signal);
  }
  signal.throwIfAborted();
  if (!record) {
    return undefined;
  }
  const oauth = options.credentialKind === "api_key" ? undefined : parseOAuthCredential(record);
  let apiKey = options.credentialKind === "oauth" ? undefined : parseApiKeyCredential(record);
  if (apiKey) {
    // Account lookup gates the API key only; legacy OAuth remains independently importable.
    const account = await client
      .request<CodexGetAccountResponse>("account/read", { refreshToken: false }, { signal })
      .catch(() => undefined);
    if (account?.account?.type !== "apiKey" || !account.requiresOpenaiAuth) {
      apiKey = undefined;
    }
  }
  signal.throwIfAborted();
  return !client.getCloseError() && client.getModelCatalogRevision() === revision
    ? { ...(oauth ? { oauth } : {}), ...(apiKey ? { apiKey } : {}) }
    : undefined;
}

function jwtExpiry(token: string): number | undefined {
  try {
    const data = asOptionalRecord(
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")),
    );
    const exp = data?.exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function parseOAuthCredential(data: Record<string, unknown>): CodexCliCredential | undefined {
  const mode = typeof data.auth_mode === "string" ? data.auth_mode.toLowerCase() : undefined;
  if (mode !== undefined && mode !== "chatgpt" && mode !== "chatgptauthtokens") {
    return undefined;
  }
  const tokens = asOptionalRecord(data.tokens);
  if (
    typeof tokens?.access_token !== "string" ||
    !tokens.access_token ||
    typeof tokens.refresh_token !== "string" ||
    !tokens.refresh_token
  ) {
    return undefined;
  }
  const lastRefresh =
    typeof data.last_refresh === "string" ? Date.parse(data.last_refresh) : Number.NaN;
  return {
    type: "oauth",
    provider: "openai",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires:
      jwtExpiry(tokens.access_token) ??
      (Number.isFinite(lastRefresh) ? lastRefresh : Date.now()) + 60 * 60 * 1000,
    ...(typeof tokens.account_id === "string" ? { accountId: tokens.account_id } : {}),
    ...(typeof tokens.id_token === "string" ? { idToken: tokens.id_token } : {}),
  };
}

function parseApiKeyCredential(
  data: Record<string, unknown>,
): CodexCliApiKeyCredential | undefined {
  const mode = typeof data.auth_mode === "string" ? data.auth_mode.toLowerCase() : undefined;
  if (mode !== undefined && mode !== "apikey" && mode !== "api_key") {
    return undefined;
  }
  const key = typeof data.OPENAI_API_KEY === "string" ? data.OPENAI_API_KEY.trim() : "";
  return key ? { type: "api_key", provider: "openai", key } : undefined;
}
