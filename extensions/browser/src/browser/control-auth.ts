import crypto from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGatewayAuth, ensureGatewayStartupAuth } from "openclaw/plugin-sdk/gateway-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { persistBrowserControlCredential } from "./config-mutations.js";

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
  const token = normalizeOptionalString(auth.token);
  const password = normalizeOptionalString(auth.password);

  switch (auth.mode) {
    case "password":
    case "trusted-proxy":
      return { password };
    case "token":
    case "none":
      return { token };
    default:
      return {};
  }
}

export function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = normalizeLowercaseStringOrEmpty(env.NODE_ENV);
  if (nodeEnv === "test") {
    return false;
  }
  const vitest = normalizeLowercaseStringOrEmpty(env.VITEST);
  return !vitest || ["0", "false", "off"].includes(vitest);
}

async function generateAndPersistBrowserControlCredential(params: {
  kind: "token" | "password";
  env: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  const credential = crypto.randomBytes(24).toString("hex");
  await persistBrowserControlCredential({ kind: params.kind, value: credential });

  // Re-read to stay consistent with any concurrent config writer.
  const persistedAuth = resolveBrowserControlAuth(getRuntimeConfig(), params.env);
  if (persistedAuth.token || persistedAuth.password) {
    return {
      auth: persistedAuth,
      generatedToken: persistedAuth[params.kind] === credential ? credential : undefined,
    };
  }

  return { auth: { [params.kind]: credential }, generatedToken: credential };
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
  const latestCfg = getRuntimeConfig();
  const latestAuth = resolveBrowserControlAuth(latestCfg, env);
  if (latestAuth.token || latestAuth.password) {
    return { auth: latestAuth };
  }
  if (latestCfg.gateway?.auth?.mode === "password") {
    return { auth: latestAuth };
  }
  const latestMode = latestCfg.gateway?.auth?.mode;
  if (latestMode === "none" || latestMode === "trusted-proxy") {
    const kind = latestMode === "trusted-proxy" ? "password" : "token";
    const credential = latestCfg.gateway?.auth?.[kind];
    if (credential != null && typeof credential !== "string") {
      // Avoid silently overwriting SecretRef-style gateway auth inputs with generated plaintext.
      // Startup will fail closed if no resolved browser auth is available.
      return { auth: latestAuth };
    }
    // trusted-proxy must use a browser-only password, never a gateway auth token.
    return await generateAndPersistBrowserControlCredential({
      kind,
      env,
    });
  }

  const ensured = await ensureGatewayStartupAuth({
    cfg: latestCfg,
    env,
    persist: true,
  });
  return {
    auth: { token: ensured.auth.token, password: ensured.auth.password },
    generatedToken: ensured.generatedToken,
  };
}
