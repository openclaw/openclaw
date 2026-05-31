import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveControlUiLinks } from "../../src/commands/onboard-helpers.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveGatewayAuthToken } from "../../src/gateway/auth-token-resolution.js";

export type ControlUiSmokeAuthMode =
  | "explicit-url-auth"
  | "explicit-url-auto-fragment"
  | "local-auto-fragment";

export type ControlUiSmokeUrl = {
  displayUrl: string;
  launchUrl: string;
  auth: {
    mode: ControlUiSmokeAuthMode;
    tokenSource?: "explicit" | "config" | "secretRef" | "env";
    tokenInOutput: false;
  };
};

type ConfigSnapshotReader = typeof readConfigFileSnapshot;
type TokenResolver = typeof resolveGatewayAuthToken;

export type ResolveControlUiSmokeUrlOptions = {
  env?: NodeJS.ProcessEnv;
  explicitUrl?: string | null;
  explicitUrlEnvNames?: string[];
  readConfig?: ConfigSnapshotReader;
  resolveToken?: TokenResolver;
  cfg?: OpenClawConfig;
};

export type ResolveControlUiSmokeProfileDirOptions = {
  displayUrl: string;
  mobile: boolean;
  env?: NodeJS.ProcessEnv;
};

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readExplicitUrl(
  env: NodeJS.ProcessEnv,
  explicitUrl: string | null | undefined,
  envNames: string[],
): string | undefined {
  const direct = normalizeOptionalString(explicitUrl);
  if (direct) {
    return direct;
  }
  for (const name of envNames) {
    const fromEnv = normalizeOptionalString(env[name]);
    if (fromEnv) {
      return fromEnv;
    }
  }
  return undefined;
}

function hashParamsFor(url: URL): URLSearchParams {
  return new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
}

export function controlUiUrlHasBootstrapAuth(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const params = new URLSearchParams(url.search);
    const hashParams = hashParamsFor(url);
    return (
      params.has("token") ||
      params.has("password") ||
      hashParams.has("token") ||
      hashParams.has("password")
    );
  } catch {
    return /(?:[#?&])(?:token|password)=/i.test(rawUrl);
  }
}

export function displayControlUiSmokeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const params = new URLSearchParams(url.search);
    params.delete("token");
    params.delete("password");
    url.search = params.toString();
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl
      .replace(/#.*$/, "")
      .replace(/([?&](?:token|password)=)[^&\s)]+/gi, "$1<redacted>");
  }
}

export function appendControlUiTokenFragment(rawUrl: string, token: string): string {
  const url = new URL(rawUrl);
  const hashParams = hashParamsFor(url);
  hashParams.set("token", token);
  url.hash = hashParams.toString();
  return url.toString();
}

export function redactControlUiSmokeSecrets(value: string): string {
  return value
    .replace(/#(?:[^\s'"`)]*)/g, (hash) =>
      /(?:^#|[&#])(?:token|password)=/i.test(hash) ? "#<redacted-auth>" : hash,
    )
    .replace(/([?&](?:token|password)=)[^&\s)]+/gi, "$1<redacted>");
}

export function extractControlUiPairingRequestId(text: string): string | null {
  const commandMatch = /\bopenclaw\s+devices\s+approve\s+([0-9a-f-]{16,})\b/i.exec(text);
  if (commandMatch?.[1]) {
    return commandMatch[1];
  }
  const rawMatch = /\brequestId:\s*([0-9a-f-]{16,})\b/i.exec(text);
  return rawMatch?.[1] ?? null;
}

function envFlagEnabled(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(raw);
}

export function controlUiSmokePersistentProfileEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envFlagEnabled(env, "OPENCLAW_CONTROL_UI_SMOKE_PERSIST_PROFILE", true);
}

export function resolveControlUiSmokeProfileDir(
  options: ResolveControlUiSmokeProfileDirOptions,
): string | null {
  const env = options.env ?? process.env;
  if (!controlUiSmokePersistentProfileEnabled(env)) {
    return null;
  }
  const explicitDir = normalizeOptionalString(env.OPENCLAW_CONTROL_UI_SMOKE_PROFILE_DIR);
  if (explicitDir) {
    return explicitDir;
  }
  const profileId = createHash("sha256")
    .update(`${options.mobile ? "mobile" : "desktop"}\n${options.displayUrl}`)
    .digest("hex")
    .slice(0, 12);
  return join(
    ".artifacts",
    "control-ui-smoke-profiles",
    `${options.mobile ? "iphone" : "desktop"}-${profileId}`,
  );
}

async function readSmokeConfig(options: ResolveControlUiSmokeUrlOptions): Promise<OpenClawConfig> {
  if (options.cfg) {
    return options.cfg;
  }
  const snapshot = await (options.readConfig ?? readConfigFileSnapshot)();
  return snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
}

async function resolveSmokeToken(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  resolveToken: TokenResolver,
): Promise<{
  token: string;
  source?: "explicit" | "config" | "secretRef" | "env";
}> {
  const resolvedToken = await resolveToken({
    cfg,
    env,
    envFallback: "always",
  });
  if (!resolvedToken.token) {
    throw new Error(
      resolvedToken.unresolvedRefReason ??
        "No gateway auth token is available. Set OPENCLAW_GATEWAY_TOKEN or pass a tokenized smoke URL.",
    );
  }
  return { token: resolvedToken.token, source: resolvedToken.source };
}

export async function resolveControlUiSmokeUrl(
  options: ResolveControlUiSmokeUrlOptions = {},
): Promise<ControlUiSmokeUrl> {
  const env = options.env ?? process.env;
  const explicitUrl = readExplicitUrl(env, options.explicitUrl, [
    ...(options.explicitUrlEnvNames ?? []),
    "OPENCLAW_CONTROL_UI_TAILNET_URL",
  ]);
  const readConfig = options.readConfig ?? readConfigFileSnapshot;
  const resolveToken = options.resolveToken ?? resolveGatewayAuthToken;

  if (explicitUrl) {
    if (controlUiUrlHasBootstrapAuth(explicitUrl)) {
      return {
        displayUrl: displayControlUiSmokeUrl(explicitUrl),
        launchUrl: explicitUrl,
        auth: { mode: "explicit-url-auth", tokenInOutput: false },
      };
    }
    const cfg = await readSmokeConfig({ ...options, readConfig });
    const token = await resolveSmokeToken(cfg, env, resolveToken);
    return {
      displayUrl: displayControlUiSmokeUrl(explicitUrl),
      launchUrl: appendControlUiTokenFragment(explicitUrl, token.token),
      auth: {
        mode: "explicit-url-auto-fragment",
        tokenSource: token.source,
        tokenInOutput: false,
      },
    };
  }

  const cfg = await readSmokeConfig({ ...options, readConfig });
  const port = resolveGatewayPort(cfg);
  const bind = cfg.gateway?.bind ?? "loopback";
  const token = await resolveSmokeToken(cfg, env, resolveToken);
  const links = resolveControlUiLinks({
    port,
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost: cfg.gateway?.customBindHost,
    basePath: cfg.gateway?.controlUi?.basePath,
    tlsEnabled: cfg.gateway?.tls?.enabled === true,
  });
  return {
    displayUrl: links.httpUrl,
    launchUrl: appendControlUiTokenFragment(links.httpUrl, token.token),
    auth: {
      mode: "local-auto-fragment",
      tokenSource: token.source,
      tokenInOutput: false,
    },
  };
}
