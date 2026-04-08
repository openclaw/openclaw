import crypto from "node:crypto";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";

export type BrowserControlAuth = {
  token?: string;
  password?: string;
};

export function resolveBrowserControlAuth(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  const auth = resolveGatewayAuth({
    authConfig: cfg?.gateway?.auth,
    env,
    tailscaleMode: cfg?.gateway?.tailscale?.mode,
  });
  const token = normalizeOptionalString(auth.token) ?? "";
  const password = normalizeOptionalString(auth.password) ?? "";
  return {
    token: token || undefined,
    password: password || undefined,
  };
}

export function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = normalizeLowercaseStringOrEmpty(env.NODE_ENV);
  if (nodeEnv === "test") {
    return false;
  }
  const vitest = normalizeLowercaseStringOrEmpty(env.VITEST);
  if (vitest && vitest !== "0" && vitest !== "false" && vitest !== "off") {
    return false;
  }
  return true;
}

function generateBrowserControlToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

async function generateAndPersistBrowserControlToken(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  const token = generateBrowserControlToken();
  const nextCfg: OpenClawConfig = {
    ...params.cfg,
    gateway: {
      ...params.cfg.gateway,
      auth: {
        ...params.cfg.gateway?.auth,
        token,
      },
    },
  };
  await writeConfigFile(nextCfg);

  // Re-read to stay consistent with any concurrent config writer.
  const persistedAuth = resolveBrowserControlAuth(loadConfig(), params.env);
  if (persistedAuth.token || persistedAuth.password) {
    return {
      auth: persistedAuth,
      generatedToken: persistedAuth.token === token ? token : undefined,
    };
  }

  return { auth: { token }, generatedToken: token };
}

export async function ensureBrowserControlAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  const env = params.env ?? process.env;
  const auth = resolveBrowserControlAuth(params.cfg, env);
  if (auth.token || auth.password) {
    return { auth };
  }
  if (!shouldAutoGenerateBrowserAuth(env)) {
    return { auth };
  }

  // Respect explicit password mode even if currently unset.
  if (params.cfg.gateway?.auth?.mode === "password") {
    return { auth };
  }

  // Re-read latest config to avoid racing with concurrent config writers.
  const latestCfg = loadConfig();
  const latestAuth = resolveBrowserControlAuth(latestCfg, env);
  if (latestAuth.token || latestAuth.password) {
    return { auth: latestAuth };
  }
  if (latestCfg.gateway?.auth?.mode === "password") {
    return { auth: latestAuth };
  }
  if (
    latestCfg.gateway?.auth?.mode === "none" ||
    latestCfg.gateway?.auth?.mode === "trusted-proxy"
  ) {
    if (latestCfg.gateway?.auth?.mode === "trusted-proxy") {
      // gateway.auth.mode=trusted-proxy must never be persisted with gateway.auth.token.
      const generatedToken = generateBrowserControlToken();
      return { auth: { token: generatedToken }, generatedToken };
    }
    return await generateAndPersistBrowserControlToken({ cfg: latestCfg, env });
  }

  const ensured = await ensureGatewayStartupAuth({
    cfg: latestCfg,
    env,
    persist: true,
  });
  const ensuredAuth = {
    token: ensured.auth.token,
    password: ensured.auth.password,
  };
  return {
    auth: ensuredAuth,
    generatedToken: ensured.generatedToken,
  };
}
