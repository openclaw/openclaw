#!/usr/bin/env node
/**
 * 🐺 ALPHABET HARVESTER - Web Scraping Engine
 * Keyrir með OpenClaw sem grunn
 */

import { createServer } from "http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import express from "express";
import fetch from "node-fetch";
import { Pool } from "pg";
import { WebSocketServer } from "ws";

function loadLocalEnvFile() {
  const envUrl = new URL("./.env", import.meta.url);

  if (!existsSync(envUrl)) {
    return;
  }

  for (const rawLine of readFileSync(envUrl, "utf8").split(/\r?\n/u)) {
    const trimmedLine = rawLine.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const normalizedLine = trimmedLine.startsWith("export ")
      ? trimmedLine.slice(7).trim()
      : trimmedLine;
    const separatorIndex = normalizedLine.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    const existingValue = process.env[key];

    if (!key || (existingValue !== undefined && existingValue !== "")) {
      continue;
    }

    let value = normalizedLine.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadLocalEnvFile();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/api/logs/stream" });
const shopifyApiSecret = process.env.SHOPIFY_API_SECRET || "";
const BLUEPRINT_SYNC_REF = "finnur-fk/main";
const SOVEREIGN_STATUS_HEADER_NAME = "X-Sovereign-Status";
const SOVEREIGN_STATUS_HEADER_VALUE = "CERTIFIED-4.3B-EUR";
const BLUEPRINT_SYNC_HEADER_NAME = "X-Blueprint-Sync";
const githubToken =
  process.env.HARVESTER_GITHUB_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  process.env.OPENCLAW_GH_TOKEN ||
  "";
const huggingFaceToken =
  process.env.HARVESTER_HF_TOKEN ||
  process.env.HARVESTER_HUGGINGFACE_TOKEN ||
  process.env.HUGGINGFACE_TOKEN ||
  process.env.HF_TOKEN ||
  process.env.HUGGING_FACE_HUB_TOKEN ||
  "";

// Configuration
const CONFIG = {
  workers: parseInt(process.env.HARVESTER_WORKERS || "15", 10),
  port: parseInt(process.env.HARVESTER_PORT || "8080", 10),
  retryDelay: 5000,
  requestTimeout: 30000,
  databaseConnectTimeout: parseInt(process.env.HARVESTER_DB_CONNECT_TIMEOUT || "10000", 10),
  databaseStatementTimeout: parseInt(process.env.HARVESTER_DB_STATEMENT_TIMEOUT || "15000", 10),
};

function readNonEmptyEnv(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return "";
}

const REVOLUT_MERCHANT_BACKFILL_SOURCE = "revolut-merchant-backfill";
const REVOLUT_MERCHANT_TARGET_ASSETS_EUR = 340000000;
const STRIPE_SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const REVOLUT_CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const DEFAULT_REVOLUT_BASE_URL = "https://b2b.revolut.com";
const DEFAULT_REVOLUT_SIGNER_PATH = "/internal/auth/revolut/client-assertion";
const REVOLUT_CANONICAL_NOTE = Object.freeze({
  id: "revolut-signer-refresh-v1",
  overview: "Harvester uses a signer-based client assertion flow for Revolut token refresh.",
  refreshRequestFields: [
    "grant_type",
    "refresh_token",
    "client_assertion_type",
    "client_assertion",
  ],
  clientIdMode: "optional-fallback",
  rules: [
    "client_assertion_type is fixed and always sent",
    "client_id is only sent when configured as a compatibility fallback",
    "refresh_token stays in runtime/env scope",
    "JWT stays runtime-only and is never persisted",
    "private key material must stay outside Postman and outside Harvester state",
  ],
});

function normalizeBaseUrl(value) {
  return value ? value.replace(/\/+$/u, "") : "";
}

function normalizePath(value, fallback) {
  const resolvedValue = (value || fallback || "").trim();

  if (!resolvedValue) {
    return "";
  }

  return resolvedValue.startsWith("/") ? resolvedValue : `/${resolvedValue}`;
}

function createServiceConfig() {
  const publicUrl = readNonEmptyEnv(["HARVESTER_PUBLIC_URL"]);
  const keyVaultUrlFromEnv = readNonEmptyEnv(["HARVESTER_KEY_VAULT_URL"]);
  const keyVaultName = readNonEmptyEnv(["HARVESTER_KEY_VAULT_NAME"]);
  const keyVaultUrl =
    keyVaultUrlFromEnv || (keyVaultName ? `https://${keyVaultName}.vault.azure.net` : "");

  return {
    publicUrl: normalizeBaseUrl(publicUrl),
    keyVaultUrl: keyVaultUrl ? `${normalizeBaseUrl(keyVaultUrl)}/` : "",
  };
}

function getHarvesterPublicUrl(req = null) {
  if (serviceConfig.publicUrl) {
    return serviceConfig.publicUrl;
  }

  if (!req) {
    return "";
  }

  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost || req.get("host");

  if (!host) {
    return "";
  }

  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = (forwardedProto || req.protocol || "https").split(",")[0].trim() || "https";
  return `${protocol}://${host}`;
}

function getRevolutMerchantWebhookUrl(req = null) {
  const publicUrl = getHarvesterPublicUrl(req);
  return publicUrl ? `${publicUrl}/api/webhooks/revolut-merchant` : null;
}

function normalizeAlphabetSource(req) {
  const candidates = [req.get("x-alphabet-source"), req.body?.source, req.query?.source];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const normalized = candidate.trim().toLowerCase();

    if (normalized) {
      return normalized;
    }
  }

  return "";
}

const serviceConfig = createServiceConfig();

function createStripeConfig() {
  const envSecretKey = readNonEmptyEnv(["STRIPE_SECRET_KEY", "STRIPE_API_KEY"]);
  const apiBaseUrl = readNonEmptyEnv(["STRIPE_API_BASE_URL"]) || "https://api.stripe.com/v1";
  const syncLimitValue =
    readNonEmptyEnv(["STRIPE_SYNC_LIMIT", "HARVESTER_STRIPE_SYNC_LIMIT"]) || "15";
  const secretName =
    readNonEmptyEnv(["STRIPE_SECRET_KEY_SECRET_NAME", "HARVESTER_STRIPE_SECRET_NAME"]) ||
    "STRIPE-SECRET-KEY";
  const parsedSyncLimit = parseInt(syncLimitValue, 10);
  const keyVaultUrl = serviceConfig.keyVaultUrl;
  const keyVaultName = keyVaultUrl ? keyVaultUrl.replace(/^https:\/\//u, "").split(".")[0] : null;

  return {
    configured: Boolean(envSecretKey || keyVaultUrl),
    envSecretKey,
    apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
    keyVaultConfigured: Boolean(keyVaultUrl),
    keyVaultName,
    keyVaultUrl,
    secretName,
    syncLimit:
      Number.isFinite(parsedSyncLimit) && parsedSyncLimit > 0 ? Math.min(parsedSyncLimit, 100) : 15,
  };
}

const stripeConfig = createStripeConfig();
const stripeSecretCache = {
  fetchedAtMs: stripeConfig.envSecretKey ? Date.now() : 0,
  source: stripeConfig.envSecretKey ? "env" : null,
  value: stripeConfig.envSecretKey || "",
};
let stripeSecretClient = null;

function createRevolutConfig() {
  const signerBaseUrl = normalizeBaseUrl(
    readNonEmptyEnv(["REVOLUT_SIGNER_BASE_URL", "HARVESTER_REVOLUT_SIGNER_BASE_URL"]),
  );
  const signerPath = normalizePath(
    readNonEmptyEnv(["REVOLUT_SIGNER_PATH", "HARVESTER_REVOLUT_SIGNER_PATH"]),
    DEFAULT_REVOLUT_SIGNER_PATH,
  );
  const revolutBaseUrl = normalizeBaseUrl(
    readNonEmptyEnv(["REVOLUT_BASE_URL", "HARVESTER_REVOLUT_BASE_URL"]) || DEFAULT_REVOLUT_BASE_URL,
  );
  const refreshToken = readNonEmptyEnv([
    "REVOLUT_REFRESH_TOKEN",
    "HARVESTER_REVOLUT_REFRESH_TOKEN",
  ]);
  const signerServiceToken = readNonEmptyEnv([
    "REVOLUT_SIGNER_SERVICE_TOKEN",
    "HARVESTER_REVOLUT_SIGNER_SERVICE_TOKEN",
  ]);
  const clientId = readNonEmptyEnv(["REVOLUT_CLIENT_ID", "HARVESTER_REVOLUT_CLIENT_ID"]);

  return {
    configured: Boolean(signerBaseUrl && signerServiceToken && refreshToken && revolutBaseUrl),
    signerConfigured: Boolean(signerBaseUrl && signerServiceToken),
    signerBaseUrl,
    signerPath,
    revolutBaseUrl,
    refreshToken,
    signerServiceToken,
    clientId,
  };
}

const revolutConfig = createRevolutConfig();
const revolutRuntime = {
  accessToken: "",
  accessTokenExpiresAt: null,
  refreshToken: revolutConfig.refreshToken,
};

function createDatabaseConfig() {
  const host = readNonEmptyEnv(["DATABASE_HOST", "POSTGRES_HOST"]);
  const portValue = readNonEmptyEnv(["DATABASE_PORT", "POSTGRES_PORT"]) || "5432";
  const database = readNonEmptyEnv(["DATABASE_NAME", "POSTGRES_DB"]);
  const user = readNonEmptyEnv(["DATABASE_USER", "POSTGRES_USER"]);
  const password = readNonEmptyEnv(["DATABASE_PASSWORD", "POSTGRES_PASSWORD"]);
  const sslMode = readNonEmptyEnv(["DATABASE_SSLMODE", "PGSSLMODE", "DATABASE_SSL"]) || "require";
  const port = parseInt(portValue, 10);
  const configured = Boolean(host && Number.isFinite(port) && database && user && password);

  return {
    configured,
    host,
    port: Number.isFinite(port) ? port : 5432,
    database,
    user,
    password,
    ssl: sslMode.toLowerCase() === "disable" ? false : { rejectUnauthorized: false },
    connectionLabel: configured
      ? `${user}@${host}:${Number.isFinite(port) ? port : 5432}/${database}`
      : null,
  };
}

const databaseConfig = createDatabaseConfig();
const databasePool = databaseConfig.configured
  ? new Pool({
      host: databaseConfig.host,
      port: databaseConfig.port,
      database: databaseConfig.database,
      user: databaseConfig.user,
      password: databaseConfig.password,
      ssl: databaseConfig.ssl,
      max: 4,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: CONFIG.databaseConnectTimeout,
      statement_timeout: CONFIG.databaseStatementTimeout,
    })
  : null;

const SHOPIFY_ORDERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS alphabet_shopify_orders (
    order_id TEXT PRIMARY KEY,
    order_name TEXT NOT NULL,
    shop_domain TEXT NOT NULL,
    topic TEXT NOT NULL,
    webhook_id TEXT,
    financial_status TEXT NOT NULL,
    fulfillment_status TEXT NOT NULL,
    currency TEXT NOT NULL,
    total_price NUMERIC(12, 2),
    customer_email TEXT,
    item_count INTEGER NOT NULL DEFAULT 0,
    line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_payload JSONB NOT NULL,
    target_status TEXT NOT NULL DEFAULT 'pending',
    last_result JSONB,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
  )
`;
const SHOPIFY_ORDERS_RECEIVED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_shopify_orders_received_at_idx
  ON alphabet_shopify_orders (received_at DESC)
`;
const SHOPIFY_ORDERS_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_shopify_orders_status_idx
  ON alphabet_shopify_orders (target_status, received_at DESC)
`;
const STRIPE_PAYMENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS alphabet_stripe_payments (
    charge_id TEXT PRIMARY KEY,
    payment_intent_id TEXT,
    customer_id TEXT,
    customer_email TEXT,
    currency TEXT NOT NULL,
    amount BIGINT NOT NULL,
    amount_captured BIGINT,
    amount_refunded BIGINT,
    status TEXT NOT NULL,
    paid BOOLEAN NOT NULL DEFAULT false,
    refunded BOOLEAN NOT NULL DEFAULT false,
    disputed BOOLEAN NOT NULL DEFAULT false,
    livemode BOOLEAN NOT NULL DEFAULT false,
    description TEXT,
    receipt_url TEXT,
    created_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_payload JSONB NOT NULL,
    target_status TEXT NOT NULL DEFAULT 'queued',
    last_result JSONB,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
  )
`;
const STRIPE_PAYMENTS_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_stripe_payments_created_at_idx
  ON alphabet_stripe_payments (created_at DESC)
`;
const STRIPE_PAYMENTS_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_stripe_payments_status_idx
  ON alphabet_stripe_payments (target_status, created_at DESC)
`;

function safeParseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isGitHubApiUrl(url) {
  return safeParseUrl(url)?.hostname === "api.github.com";
}

function isHuggingFaceUrl(url) {
  return safeParseUrl(url)?.hostname === "huggingface.co";
}

function isHuggingFaceApiUrl(url) {
  const parsed = safeParseUrl(url);
  return parsed?.hostname === "huggingface.co" && parsed.pathname.startsWith("/api/");
}

function createRequestHeaders(url) {
  const headers = {
    "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
    [BLUEPRINT_SYNC_HEADER_NAME]: BLUEPRINT_SYNC_REF,
    [SOVEREIGN_STATUS_HEADER_NAME]: SOVEREIGN_STATUS_HEADER_VALUE,
  };

  if (isGitHubApiUrl(url)) {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2026-03-10";

    if (githubToken) {
      headers.Authorization = `Bearer ${githubToken}`;
    }

    return headers;
  }

  if (!isHuggingFaceUrl(url)) {
    return headers;
  }

  if (isHuggingFaceApiUrl(url)) {
    headers.Accept = "application/json";
  }

  if (huggingFaceToken) {
    headers.Authorization = `Bearer ${huggingFaceToken}`;
  }

  return headers;
}

function safeCompareStrings(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}

function normalizeStripeExpandableId(value) {
  if (typeof value === "string" && value) {
    return value;
  }

  if (value && typeof value === "object" && typeof value.id === "string") {
    return value.id;
  }

  return null;
}

function unixSecondsToIso(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  return Number.isFinite(parsed) ? new Date(parsed * 1000).toISOString() : null;
}

function clampStripeSyncLimit(value) {
  const parsed = Number.parseInt(String(value ?? stripeConfig.syncLimit), 10);

  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : stripeConfig.syncLimit;
}

async function withDatabaseClient(callback) {
  if (!databasePool) {
    throw new Error("Database is not configured for the harvester");
  }

  const client = await databasePool.connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

function createStripeSecretClient() {
  if (!stripeConfig.keyVaultConfigured) {
    return null;
  }

  if (!stripeSecretClient) {
    stripeSecretClient = new SecretClient(stripeConfig.keyVaultUrl, new DefaultAzureCredential());
  }

  return stripeSecretClient;
}

async function resolveStripeSecretKey({ forceRefresh = false } = {}) {
  if (stripeConfig.envSecretKey) {
    state.stripe.secretPresent = true;
    state.stripe.secretSource = "env";
    return stripeConfig.envSecretKey;
  }

  if (!stripeConfig.keyVaultConfigured) {
    throw new Error("Stripe Key Vault configuration is missing");
  }

  const cacheIsWarm =
    stripeSecretCache.value &&
    Date.now() - stripeSecretCache.fetchedAtMs < STRIPE_SECRET_CACHE_TTL_MS;

  if (!forceRefresh && cacheIsWarm) {
    state.stripe.secretPresent = true;
    state.stripe.secretSource = stripeSecretCache.source || "keyvault";
    return stripeSecretCache.value;
  }

  try {
    const secretClient = createStripeSecretClient();
    const secret = await secretClient.getSecret(stripeConfig.secretName);

    if (!secret.value) {
      throw new Error(`Key Vault secret ${stripeConfig.secretName} has no value`);
    }

    stripeSecretCache.value = secret.value;
    stripeSecretCache.source = "keyvault";
    stripeSecretCache.fetchedAtMs = Date.now();

    state.stripe.secretPresent = true;
    state.stripe.secretSource = "keyvault";
    state.stripe.lastSecretResolvedAt = new Date().toISOString();
    state.stripe.lastError = null;
    state.stripe.lastUpdated = state.stripe.lastSecretResolvedAt;
    return secret.value;
  } catch (error) {
    state.stripe.secretPresent = false;
    state.stripe.secretSource = "keyvault";
    state.stripe.lastError = error.message;
    state.stripe.lastUpdated = new Date().toISOString();
    throw new Error(`Stripe secret resolution failed: ${error.message}`);
  }
}

async function callStripeApi(path, searchParams = null, options = {}) {
  if (!stripeConfig.configured) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  const stripeSecretKey = await resolveStripeSecretKey({
    forceRefresh: options.forceSecretRefresh === true,
  });

  const sanitizedPath = path.replace(/^\/+|\/+$/gu, "");
  const requestUrl = new URL(`${stripeConfig.apiBaseUrl}/${sanitizedPath}`);

  if (searchParams instanceof URLSearchParams) {
    requestUrl.search = searchParams.toString();
  }

  const response = await fetch(requestUrl, {
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      Accept: "application/json",
      [BLUEPRINT_SYNC_HEADER_NAME]: BLUEPRINT_SYNC_REF,
      [SOVEREIGN_STATUS_HEADER_NAME]: SOVEREIGN_STATUS_HEADER_VALUE,
      "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
    },
  });
  const payload = await parseResponsePayload(response);

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? payload.error?.message || JSON.stringify(payload)
        : String(payload);

    throw new Error(`Stripe API ${response.status}: ${detail}`);
  }

  state.stripe.lastError = null;
  state.stripe.lastUpdated = new Date().toISOString();
  return payload;
}

async function parseResponsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? await response.json() : await response.text();
}

function resolveRuntimeRefreshToken() {
  return revolutRuntime.refreshToken || revolutConfig.refreshToken || "";
}

function normalizeExpiryToIso(value, referenceTimeMs = Date.now()) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return null;
    }

    const directDate = Date.parse(trimmedValue);

    if (Number.isFinite(directDate)) {
      return new Date(directDate).toISOString();
    }

    const numericValue = Number.parseInt(trimmedValue, 10);

    if (!Number.isFinite(numericValue)) {
      return null;
    }

    value = numericValue;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  if (value > 1_000_000_000_000) {
    return new Date(value).toISOString();
  }

  if (value > 1_000_000_000) {
    return new Date(value * 1000).toISOString();
  }

  return new Date(referenceTimeMs + value * 1000).toISOString();
}

async function requestRevolutClientAssertion() {
  if (!revolutConfig.signerConfigured) {
    throw new Error("Revolut signer service is not configured");
  }

  const signerUrl = new URL(revolutConfig.signerPath, `${revolutConfig.signerBaseUrl}/`);
  const response = await fetch(signerUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${revolutConfig.signerServiceToken}`,
      [BLUEPRINT_SYNC_HEADER_NAME]: BLUEPRINT_SYNC_REF,
      [SOVEREIGN_STATUS_HEADER_NAME]: SOVEREIGN_STATUS_HEADER_VALUE,
      "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
    },
  });
  const payload = await parseResponsePayload(response);

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? payload.error || payload.message || JSON.stringify(payload)
        : String(payload);

    throw new Error(`Revolut signer ${response.status}: ${detail}`);
  }

  const jwt =
    typeof payload?.jwt === "string"
      ? payload.jwt
      : typeof payload?.client_assertion === "string"
        ? payload.client_assertion
        : typeof payload?.clientAssertion === "string"
          ? payload.clientAssertion
          : "";

  if (!jwt) {
    throw new Error("Signer response did not include jwt");
  }

  const now = new Date().toISOString();
  const assertionExpiresAt = normalizeExpiryToIso(
    payload?.expires_at ?? payload?.expiresAt ?? payload?.exp ?? null,
  );

  state.revolut.lastAssertionIssuedAt = now;
  state.revolut.lastAssertionExpiresAt = assertionExpiresAt;
  state.revolut.lastSignerStatus = response.status;
  state.revolut.lastError = null;
  state.revolut.lastUpdated = now;
  return { jwt, signerUrl: signerUrl.toString() };
}

async function refreshRevolutAccessToken() {
  if (!revolutConfig.configured) {
    throw new Error("Revolut signer refresh flow is not configured");
  }

  const refreshToken = resolveRuntimeRefreshToken();

  if (!refreshToken) {
    throw new Error("Revolut refresh token is missing");
  }

  const { jwt, signerUrl } = await requestRevolutClientAssertion();
  const tokenUrl = new URL("/api/1.0/auth/token", `${revolutConfig.revolutBaseUrl}/`);
  const formBody = new URLSearchParams();

  formBody.set("grant_type", "refresh_token");
  formBody.set("refresh_token", refreshToken);
  formBody.set("client_assertion_type", REVOLUT_CLIENT_ASSERTION_TYPE);
  formBody.set("client_assertion", jwt);

  if (revolutConfig.clientId) {
    formBody.set("client_id", revolutConfig.clientId);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      [BLUEPRINT_SYNC_HEADER_NAME]: BLUEPRINT_SYNC_REF,
      [SOVEREIGN_STATUS_HEADER_NAME]: SOVEREIGN_STATUS_HEADER_VALUE,
      "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
    },
    body: formBody,
  });
  const payload = await parseResponsePayload(response);

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? payload.error_description || payload.error || payload.message || JSON.stringify(payload)
        : String(payload);

    throw new Error(`Revolut token refresh ${response.status}: ${detail}`);
  }

  if (!payload?.access_token) {
    throw new Error("Revolut token response did not include access_token");
  }

  const now = new Date().toISOString();
  const rotatedRefreshToken =
    typeof payload?.refresh_token === "string" &&
    payload.refresh_token &&
    payload.refresh_token !== refreshToken
      ? payload.refresh_token
      : null;

  revolutRuntime.accessToken = payload.access_token;
  revolutRuntime.accessTokenExpiresAt = normalizeExpiryToIso(payload?.expires_in ?? null);

  if (rotatedRefreshToken) {
    revolutRuntime.refreshToken = rotatedRefreshToken;
    process.env.REVOLUT_REFRESH_TOKEN = rotatedRefreshToken;
  }

  state.revolut.accessTokenPresent = true;
  state.revolut.accessTokenExpiresAt = revolutRuntime.accessTokenExpiresAt;
  state.revolut.refreshTokenPresent = Boolean(resolveRuntimeRefreshToken());
  state.revolut.lastError = null;
  state.revolut.lastRefreshAt = now;
  state.revolut.lastRefreshStatus = response.status;
  state.revolut.lastUpdated = now;
  state.revolut.lastGrantedScope = typeof payload?.scope === "string" ? payload.scope : null;
  state.revolut.lastTokenType = typeof payload?.token_type === "string" ? payload.token_type : null;
  state.revolut.rotatedRefreshTokenAt = rotatedRefreshToken
    ? now
    : state.revolut.rotatedRefreshTokenAt;

  return {
    accessTokenExpiresAt: revolutRuntime.accessTokenExpiresAt,
    accessTokenPresent: true,
    clientIdMode: state.revolut.clientIdMode,
    expiresIn: Number.isFinite(Number(payload?.expires_in)) ? Number(payload.expires_in) : null,
    refreshTokenRotated: Boolean(rotatedRefreshToken),
    revolutBaseUrl: revolutConfig.revolutBaseUrl,
    scope: state.revolut.lastGrantedScope,
    signerBaseUrl: revolutConfig.signerBaseUrl,
    signerRequestUrl: signerUrl,
    tokenRequestUrl: tokenUrl.toString(),
    tokenType: state.revolut.lastTokenType,
  };
}

function markDatabaseState({ connected, persistenceReady, error = null }) {
  state.database.connected = connected;
  state.database.persistenceReady = persistenceReady;
  state.database.lastCheckedAt = new Date().toISOString();
  state.database.lastError = error ? error.message || String(error) : null;
}

async function initializeDatabase() {
  if (!databasePool) {
    markDatabaseState({ connected: false, persistenceReady: false });
    return false;
  }

  try {
    await withDatabaseClient(async (client) => {
      await client.query("SELECT 1");
      await client.query(SHOPIFY_ORDERS_TABLE_SQL);
      await client.query(SHOPIFY_ORDERS_RECEIVED_AT_INDEX_SQL);
      await client.query(SHOPIFY_ORDERS_STATUS_INDEX_SQL);
      await client.query(STRIPE_PAYMENTS_TABLE_SQL);
      await client.query(STRIPE_PAYMENTS_CREATED_AT_INDEX_SQL);
      await client.query(STRIPE_PAYMENTS_STATUS_INDEX_SQL);
    });

    markDatabaseState({ connected: true, persistenceReady: true });
    await refreshStripePaymentCount();
    log("success", `🗄️ Connected to PostgreSQL target ${databaseConfig.connectionLabel}`);
    log("success", "🗄️ Shopify order persistence ready in alpacoredb");
    log("success", "🗄️ Stripe payment persistence ready in alpacoredb");
    return true;
  } catch (error) {
    markDatabaseState({ connected: false, persistenceReady: false, error });
    log("error", `🗄️ PostgreSQL initialization failed: ${error.message}`);
    throw error;
  }
}

async function ensureDatabaseReady(reason) {
  if (!databasePool) {
    return false;
  }

  if (state.database.connected && state.database.persistenceReady) {
    return true;
  }

  log("warning", `🗄️ Reconnecting PostgreSQL for ${reason}...`);
  await initializeDatabase();
  return true;
}

async function persistQueuedShopifyOrder(summary, payload) {
  if (!databasePool) {
    return;
  }

  await withDatabaseClient((client) =>
    client.query(
      `
        INSERT INTO alphabet_shopify_orders (
          order_id,
          order_name,
          shop_domain,
          topic,
          webhook_id,
          financial_status,
          fulfillment_status,
          currency,
          total_price,
          customer_email,
          item_count,
          line_items,
          raw_payload,
          target_status,
          queued_at,
          processed_at,
          last_result
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12::jsonb,
          $13::jsonb,
          'queued',
          NOW(),
          NULL,
          NULL
        )
        ON CONFLICT (order_id) DO UPDATE SET
          order_name = EXCLUDED.order_name,
          shop_domain = EXCLUDED.shop_domain,
          topic = EXCLUDED.topic,
          webhook_id = EXCLUDED.webhook_id,
          financial_status = EXCLUDED.financial_status,
          fulfillment_status = EXCLUDED.fulfillment_status,
          currency = EXCLUDED.currency,
          total_price = EXCLUDED.total_price,
          customer_email = EXCLUDED.customer_email,
          item_count = EXCLUDED.item_count,
          line_items = EXCLUDED.line_items,
          raw_payload = EXCLUDED.raw_payload,
          target_status = EXCLUDED.target_status,
          queued_at = NOW(),
          processed_at = NULL,
          last_result = NULL
      `,
      [
        summary.orderId,
        summary.orderName,
        summary.shop,
        summary.topic,
        summary.webhookId,
        summary.financialStatus,
        summary.fulfillmentStatus,
        summary.currency,
        toNullableNumber(summary.totalPrice),
        summary.customerEmail,
        summary.itemCount,
        stringifyJson(summary.lineItems),
        stringifyJson(payload),
      ],
    ),
  );

  markDatabaseState({ connected: true, persistenceReady: true });
}

async function persistShopifyOutcome(summary, targetStatus, lastResult) {
  if (!databasePool) {
    return;
  }

  await withDatabaseClient((client) =>
    client.query(
      `
        UPDATE alphabet_shopify_orders
        SET target_status = $2,
            processed_at = NOW(),
            last_result = $3::jsonb
        WHERE order_id = $1
      `,
      [summary.orderId, targetStatus, stringifyJson(lastResult)],
    ),
  );

  markDatabaseState({ connected: true, persistenceReady: true });
}

async function refreshStripePaymentCount() {
  if (!databasePool) {
    state.stripe.persistedCount = 0;
    return 0;
  }

  const result = await withDatabaseClient((client) =>
    client.query("SELECT COUNT(*)::int AS count FROM alphabet_stripe_payments"),
  );
  const count = Number(result.rows[0]?.count || 0);

  state.stripe.persistedCount = count;
  state.stripe.lastUpdated = new Date().toISOString();
  return count;
}

async function upsertStripeChargeRecord(summary, payload, targetStatus, lastResult, processedAt) {
  if (!databasePool) {
    return;
  }

  await withDatabaseClient((client) =>
    client.query(
      `
        INSERT INTO alphabet_stripe_payments (
          charge_id,
          payment_intent_id,
          customer_id,
          customer_email,
          currency,
          amount,
          amount_captured,
          amount_refunded,
          status,
          paid,
          refunded,
          disputed,
          livemode,
          description,
          receipt_url,
          created_at,
          metadata,
          raw_payload,
          target_status,
          processed_at,
          last_result
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17::jsonb,
          $18::jsonb,
          $19,
          $20,
          $21::jsonb
        )
        ON CONFLICT (charge_id) DO UPDATE SET
          payment_intent_id = EXCLUDED.payment_intent_id,
          customer_id = EXCLUDED.customer_id,
          customer_email = EXCLUDED.customer_email,
          currency = EXCLUDED.currency,
          amount = EXCLUDED.amount,
          amount_captured = EXCLUDED.amount_captured,
          amount_refunded = EXCLUDED.amount_refunded,
          status = EXCLUDED.status,
          paid = EXCLUDED.paid,
          refunded = EXCLUDED.refunded,
          disputed = EXCLUDED.disputed,
          livemode = EXCLUDED.livemode,
          description = EXCLUDED.description,
          receipt_url = EXCLUDED.receipt_url,
          created_at = EXCLUDED.created_at,
          metadata = EXCLUDED.metadata,
          raw_payload = EXCLUDED.raw_payload,
          target_status = EXCLUDED.target_status,
          queued_at = CASE
            WHEN EXCLUDED.target_status = 'queued' THEN NOW()
            ELSE alphabet_stripe_payments.queued_at
          END,
          processed_at = EXCLUDED.processed_at,
          last_result = EXCLUDED.last_result
      `,
      [
        summary.chargeId,
        summary.paymentIntentId,
        summary.customerId,
        summary.customerEmail,
        summary.currency,
        summary.amount,
        summary.amountCaptured,
        summary.amountRefunded,
        summary.status,
        summary.paid,
        summary.refunded,
        summary.disputed,
        summary.livemode,
        summary.description,
        summary.receiptUrl,
        summary.createdAt,
        stringifyJson(summary.metadata),
        stringifyJson(payload),
        targetStatus,
        processedAt,
        stringifyJson(lastResult),
      ],
    ),
  );

  markDatabaseState({ connected: true, persistenceReady: true });
  await refreshStripePaymentCount();
}

async function persistQueuedStripeCharge(summary, payload) {
  await upsertStripeChargeRecord(summary, payload, "queued", null, null);
}

async function persistStripeOutcome(summary, targetStatus, payload, lastResult) {
  await upsertStripeChargeRecord(
    summary,
    payload,
    targetStatus,
    lastResult,
    new Date().toISOString(),
  );
}

async function runStripeHealthCheck() {
  const account = await callStripeApi("account", null, { forceSecretRefresh: true });
  const checkedAt = new Date().toISOString();

  state.stripe.accountId = account?.id || null;
  state.stripe.accountCountry = account?.country || null;
  state.stripe.businessName = account?.business_profile?.name || null;
  state.stripe.chargesEnabled = Boolean(account?.charges_enabled);
  state.stripe.payoutsEnabled = Boolean(account?.payouts_enabled);
  state.stripe.livemode = Boolean(account?.livemode);
  state.stripe.lastHealthCheck = checkedAt;
  state.stripe.lastError = null;
  state.stripe.lastUpdated = checkedAt;

  return {
    accountId: state.stripe.accountId,
    country: state.stripe.accountCountry,
    businessName: state.stripe.businessName,
    livemode: state.stripe.livemode,
    chargesEnabled: state.stripe.chargesEnabled,
    payoutsEnabled: state.stripe.payoutsEnabled,
    checkedAt,
  };
}

async function fetchStripeCharges(limit) {
  const searchParams = new URLSearchParams();
  searchParams.set("limit", String(limit));
  searchParams.set("expand[]", "data.customer");
  if (arguments.length > 1 && arguments[1]) {
    searchParams.set("starting_after", String(arguments[1]));
  }
  return callStripeApi("charges", searchParams);
}

async function fetchAllStripeCharges(limit) {
  const allCharges = [];
  let hasMore = true;
  let startingAfter = null;
  let pagesFetched = 0;

  while (hasMore && pagesFetched < 100) {
    const payload = await fetchStripeCharges(limit, startingAfter);
    const charges = Array.isArray(payload?.data) ? payload.data : [];

    allCharges.push(...charges);
    pagesFetched += 1;
    hasMore = Boolean(payload?.has_more) && charges.length > 0;
    startingAfter = hasMore ? charges.at(-1)?.id || null : null;

    if (!hasMore) {
      break;
    }
  }

  return {
    data: allCharges,
    has_more: hasMore,
    pagesFetched,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

app.use((req, res, next) => {
  res.setHeader(SOVEREIGN_STATUS_HEADER_NAME, SOVEREIGN_STATUS_HEADER_VALUE);
  res.setHeader(BLUEPRINT_SYNC_HEADER_NAME, BLUEPRINT_SYNC_REF);
  next();
});

function authenticateShopifyWebhook(req, res, next) {
  if (!shopifyApiSecret) {
    log("warning", "🛍️ Shopify webhook rejected: SHOPIFY_API_SECRET is not configured");
    return res.status(503).json({ error: "SHOPIFY_API_SECRET is not configured" });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
  const providedHmac = req.get("x-shopify-hmac-sha256")?.trim() || "";

  if (!rawBody) {
    return res.status(400).json({ error: "Raw Shopify request body is required" });
  }

  if (!providedHmac) {
    return res.status(401).json({ error: "X-Shopify-Hmac-Sha256 header required" });
  }

  const expectedHmac = createHmac("sha256", shopifyApiSecret).update(rawBody).digest("base64");

  if (!safeCompareStrings(providedHmac, expectedHmac)) {
    log("warning", "🛍️ Shopify webhook rejected: invalid HMAC signature");
    return res.status(401).json({ error: "Invalid Shopify HMAC" });
  }

  next();
}

function summarizeShopifyOrder(payload, topic, shop, webhookId) {
  const numericOrderNumber = Number(payload?.order_number);
  const totalPrice = payload?.current_total_price ?? payload?.total_price ?? null;
  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
  const itemCount = lineItems.reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0);
  const orderId = payload?.id ?? payload?.admin_graphql_api_id ?? webhookId ?? randomUUID();

  return {
    topic,
    shop,
    webhookId,
    orderId: String(orderId),
    orderName:
      payload?.name ||
      (Number.isFinite(numericOrderNumber) ? `#${numericOrderNumber}` : null) ||
      `order-${String(orderId).slice(-8)}`,
    financialStatus:
      typeof payload?.financial_status === "string" ? payload.financial_status : "unknown",
    fulfillmentStatus:
      typeof payload?.fulfillment_status === "string" ? payload.fulfillment_status : "unfulfilled",
    currency: payload?.currency || payload?.presentment_currency || "unknown",
    totalPrice,
    customerEmail: payload?.email || payload?.customer?.email || null,
    itemCount,
    lineItems: lineItems.map((item) => ({
      title: item?.title || "Untitled item",
      quantity: Number(item?.quantity) || 0,
      sku: item?.sku || null,
    })),
  };
}

function summarizeStripeCharge(charge) {
  const chargeId = charge?.id || randomUUID();

  return {
    chargeId: String(chargeId),
    paymentIntentId: normalizeStripeExpandableId(charge?.payment_intent),
    customerId: normalizeStripeExpandableId(charge?.customer),
    customerEmail:
      charge?.billing_details?.email || charge?.receipt_email || charge?.customer?.email || null,
    currency: charge?.currency || "unknown",
    amount: Number(charge?.amount) || 0,
    amountCaptured: Number(charge?.amount_captured) || 0,
    amountRefunded: Number(charge?.amount_refunded) || 0,
    status: charge?.status || (charge?.paid ? "succeeded" : "unknown"),
    paid: Boolean(charge?.paid),
    refunded: Boolean(charge?.refunded),
    disputed: Boolean(charge?.disputed),
    livemode: Boolean(charge?.livemode),
    description: charge?.description || null,
    receiptUrl: charge?.receipt_url || null,
    createdAt: unixSecondsToIso(charge?.created),
    metadata: charge?.metadata && typeof charge.metadata === "object" ? charge.metadata : {},
  };
}

function isPaidShopifyOrder(topic, payload) {
  if (topic === "orders/paid") {
    return true;
  }

  return `${payload?.financial_status || ""}`.toLowerCase() === "paid";
}

function createShopifyOrderWorkItem(summary) {
  return {
    id: `shopify-paid-order:${summary.orderId}`,
    kind: "shopify-paid-order",
    url: `shopify://${summary.shop}/orders/${summary.orderId}`,
    label: `Shopify paid order ${summary.orderName}`,
    dedupeKey: `shopify-paid-order:${summary.orderId}`,
    status: "pending",
    progress: 0,
    source: "shopify",
    shopifyOrder: summary,
  };
}

function createStripeChargeWorkItem(summary) {
  const amount = Number.isFinite(summary.amount) ? (summary.amount / 100).toFixed(2) : "0.00";

  return {
    id: `stripe-charge:${summary.chargeId}`,
    kind: "stripe-charge",
    url: `stripe://charges/${summary.chargeId}`,
    label: `Stripe charge ${summary.chargeId} (${amount} ${summary.currency})`,
    dedupeKey: `stripe-charge:${summary.chargeId}`,
    status: "pending",
    progress: 0,
    source: "stripe",
    stripeCharge: summary,
  };
}

function enqueueTarget(target) {
  const existingTarget =
    target.dedupeKey &&
    state.targets.find(
      (candidate) => candidate.dedupeKey === target.dedupeKey && candidate.status !== "failed",
    );

  if (existingTarget) {
    return { queued: false, target: existingTarget };
  }

  state.targets.push(target);
  return { queued: true, target };
}

async function processShopifyPaidOrder(target, workerId) {
  const summary = target.shopifyOrder;

  target.progress = 20;
  log(
    "info",
    `[Worker ${workerId}] 🛍️ Alphabet picked up paid Shopify order ${summary.orderName} from ${summary.shop}`,
  );

  await sleep(250);
  target.progress = 55;

  log(
    "info",
    `[Worker ${workerId}] 📦 Preparing order ${summary.orderName}: ${summary.itemCount} items, ${summary.totalPrice ?? "unknown"} ${summary.currency}`,
  );

  await sleep(250);
  target.progress = 85;

  const result = {
    startedAt: new Date().toISOString(),
    orderId: summary.orderId,
    orderName: summary.orderName,
    shop: summary.shop,
    itemCount: summary.itemCount,
    totalPrice: summary.totalPrice,
    currency: summary.currency,
    customerEmail: summary.customerEmail,
  };

  target.result = result;
  return { success: true, data: result };
}

async function processStripeCharge(target, workerId) {
  const summary = target.stripeCharge;

  target.progress = 15;
  log("info", `[Worker ${workerId}] 💳 Syncing Stripe charge ${summary.chargeId}`);

  const charge = await callStripeApi(`charges/${summary.chargeId}`);
  const refreshedSummary = summarizeStripeCharge(charge);

  target.progress = 70;
  await sleep(150);
  target.progress = 90;

  const result = {
    syncedAt: new Date().toISOString(),
    chargeId: refreshedSummary.chargeId,
    paymentIntentId: refreshedSummary.paymentIntentId,
    amount: refreshedSummary.amount,
    currency: refreshedSummary.currency,
    status: refreshedSummary.status,
    customerEmail: refreshedSummary.customerEmail,
    livemode: refreshedSummary.livemode,
  };

  target.result = result;
  return {
    success: true,
    data: result,
    summary: refreshedSummary,
    rawCharge: charge,
  };
}

// State

function updateGitHubRateLimit(headers) {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  const used = headers.get("x-ratelimit-used");
  const resource = headers.get("x-ratelimit-resource");

  if (!limit && !remaining && !reset && !used && !resource) {
    return;
  }

  state.github.rateLimit = {
    limit: limit ? parseInt(limit, 10) : null,
    remaining: remaining ? parseInt(remaining, 10) : null,
    reset: reset ? parseInt(reset, 10) : null,
    used: used ? parseInt(used, 10) : null,
    resource: resource || "core",
  };
  state.github.lastUpdated = new Date().toISOString();
}
const state = {
  targets: [],
  logs: [],
  github: {
    tokenPresent: Boolean(githubToken),
    authMode: githubToken ? "authenticated" : "public",
    rateLimit: null,
    lastError: null,
    lastUpdated: null,
  },
  huggingFace: {
    tokenPresent: Boolean(huggingFaceToken),
    authMode: huggingFaceToken ? "authenticated" : "public",
    lastError: null,
    lastUpdated: null,
  },
  shopify: {
    secretPresent: Boolean(shopifyApiSecret),
    authMode: shopifyApiSecret ? "hmac" : "disabled",
    lastError: null,
    lastUpdated: null,
  },
  stripe: {
    secretPresent: Boolean(stripeConfig.envSecretKey),
    secretConfigured: stripeConfig.configured,
    authMode: stripeConfig.configured ? "bearer" : "disabled",
    apiBaseUrl: stripeConfig.apiBaseUrl,
    keyVaultConfigured: stripeConfig.keyVaultConfigured,
    keyVaultName: stripeConfig.keyVaultName,
    blueprintSyncRef: BLUEPRINT_SYNC_REF,
    lastSecretResolvedAt: stripeConfig.envSecretKey ? new Date().toISOString() : null,
    merchantWebhookUrl: getRevolutMerchantWebhookUrl(),
    publicUrl: getHarvesterPublicUrl(),
    secretName: stripeConfig.secretName,
    secretSource: stripeConfig.envSecretKey
      ? "env"
      : stripeConfig.keyVaultConfigured
        ? "keyvault"
        : "missing",
    accountId: null,
    accountCountry: null,
    businessName: null,
    chargesEnabled: null,
    payoutsEnabled: null,
    livemode: null,
    persistedCount: 0,
    lastError: null,
    lastHealthCheck: null,
    lastSyncAt: null,
    lastSyncQueued: 0,
    lastSyncPages: 0,
    lastSyncedPayments: 0,
    lastUpdated: null,
    merchantBackfill: {
      active: false,
      lastEventType: null,
      lastQueued: 0,
      lastRequestedAt: null,
      lastWebhookId: null,
      sourceHeader: REVOLUT_MERCHANT_BACKFILL_SOURCE,
      targetAssetsEur: REVOLUT_MERCHANT_TARGET_ASSETS_EUR,
    },
  },
  revolut: {
    accessTokenExpiresAt: null,
    accessTokenPresent: false,
    canonicalNote: REVOLUT_CANONICAL_NOTE,
    clientAssertionType: REVOLUT_CLIENT_ASSERTION_TYPE,
    clientIdMode: revolutConfig.clientId ? "fallback" : "jwt-sub",
    clientIdPresent: Boolean(revolutConfig.clientId),
    configured: revolutConfig.configured,
    lastAssertionExpiresAt: null,
    lastAssertionIssuedAt: null,
    lastError: revolutConfig.configured
      ? null
      : "REVOLUT signer base URL, signer token, and refresh token must be configured",
    lastGrantedScope: null,
    lastRefreshAt: null,
    lastRefreshStatus: null,
    lastSignerStatus: null,
    lastTokenType: null,
    lastUpdated: null,
    refreshTokenPresent: Boolean(resolveRuntimeRefreshToken()),
    revolutBaseUrl: revolutConfig.revolutBaseUrl,
    rotatedRefreshTokenAt: null,
    signerBaseUrl: revolutConfig.signerBaseUrl,
    signerConfigured: revolutConfig.signerConfigured,
    signerPath: revolutConfig.signerPath,
  },
  database: {
    configured: databaseConfig.configured,
    connected: false,
    persistenceReady: false,
    connectionLabel: databaseConfig.connectionLabel,
    lastError: databaseConfig.configured ? null : "DATABASE_* env vars not configured",
    lastCheckedAt: null,
  },
  stats: {
    workers: CONFIG.workers,
    active: 0,
    completed: 0,
    failed: 0,
  },
  workers: [],
};

// Target list - Bættu þínum eigin targets hér
const DEFAULT_TARGETS = [
  { url: "https://httpbin.org/html", status: "pending", progress: 0 },
  { url: "https://httpbin.org/json", status: "pending", progress: 0 },
];

/**
 * Log function that broadcasts to all connected WebSocket clients
 */
function log(level, message) {
  const logEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
  };

  // Store in memory (keep last 500)
  state.logs.push(logEntry);
  if (state.logs.length > 500) {
    state.logs.shift();
  }

  // Broadcast to all WS clients
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      // OPEN
      client.send(JSON.stringify(logEntry));
    }
  });

  // Also log to console
  const colorMap = {
    info: "\x1b[36m", // cyan
    success: "\x1b[32m", // green
    warning: "\x1b[33m", // yellow
    error: "\x1b[31m", // red
    debug: "\x1b[35m", // magenta
  };
  const color = colorMap[level] || "\x1b[37m";
  const reset = "\x1b[0m";
  console.log(`${color}[${level.toUpperCase()}]${reset} ${message}`);
}

/**
 * Harvester Worker - scrapes a single target
 */
async function harvestTarget(target, workerId) {
  const startTime = Date.now();
  const targetLabel =
    target.label || target.url || target.kind || `target-${target.id || "unknown"}`;
  let stripeOutcome = null;

  try {
    log("info", `[Worker ${workerId}] Starting: ${targetLabel}`);
    target.status = "active";
    state.stats.active++;

    let data;

    if (target.kind === "shopify-paid-order") {
      const result = await processShopifyPaidOrder(target, workerId);
      data = result.data;
    } else if (target.kind === "stripe-charge") {
      stripeOutcome = await processStripeCharge(target, workerId);
      target.stripeCharge = stripeOutcome.summary;
      data = stripeOutcome.data;
    } else {
      // Fetch the URL
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

      const response = await fetch(target.url, {
        signal: controller.signal,
        headers: createRequestHeaders(target.url),
      });

      if (isGitHubApiUrl(target.url)) {
        updateGitHubRateLimit(response.headers);
        state.github.lastError = null;
        state.github.lastUpdated = new Date().toISOString();
      }

      if (isHuggingFaceUrl(target.url)) {
        state.huggingFace.lastError = null;
        state.huggingFace.lastUpdated = new Date().toISOString();
      }

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        data = await response.json();
        log("success", `[Worker ${workerId}] JSON data retrieved from ${target.url}`);
      } else {
        const text = await response.text();
        data = text.substring(0, 200); // First 200 chars
        log("success", `[Worker ${workerId}] HTML/Text data retrieved (${text.length} bytes)`);
      }

      // Simulate processing time
      await sleep(Math.random() * 2000);
    }

    target.status = "completed";
    target.progress = 100;

    if (target.kind === "shopify-paid-order") {
      await persistShopifyOutcome(target.shopifyOrder, "completed", {
        ...data,
        completedAt: new Date().toISOString(),
      });
    } else if (target.kind === "stripe-charge") {
      await persistStripeOutcome(target.stripeCharge, "completed", stripeOutcome.rawCharge, {
        ...data,
        completedAt: new Date().toISOString(),
      });
    }

    state.stats.active--;
    state.stats.completed++;

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log("success", `[Worker ${workerId}] ✅ Completed ${targetLabel} in ${duration}s`);

    return { success: true, data };
  } catch (error) {
    if (isGitHubApiUrl(target.url)) {
      state.github.lastError = error.message;
      state.github.lastUpdated = new Date().toISOString();
    }

    if (isHuggingFaceUrl(target.url)) {
      state.huggingFace.lastError = error.message;
      state.huggingFace.lastUpdated = new Date().toISOString();
    }

    if (target.kind === "shopify-paid-order") {
      try {
        await persistShopifyOutcome(target.shopifyOrder, "failed", {
          error: error.message,
          failedAt: new Date().toISOString(),
        });
      } catch (databaseError) {
        log(
          "error",
          `[Worker ${workerId}] 🗄️ Failed to persist Shopify failure state for ${targetLabel}: ${databaseError.message}`,
        );
      }
    } else if (target.kind === "stripe-charge") {
      try {
        await persistStripeOutcome(target.stripeCharge, "failed", target.stripeCharge, {
          error: error.message,
          failedAt: new Date().toISOString(),
        });
      } catch (databaseError) {
        log(
          "error",
          `[Worker ${workerId}] 🗄️ Failed to persist Stripe failure state for ${targetLabel}: ${databaseError.message}`,
        );
      }
    }

    target.status = "failed";
    target.progress = 0;
    state.stats.active--;
    state.stats.failed++;

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log("error", `[Worker ${workerId}] ❌ Failed ${targetLabel}: ${error.message} (${duration}s)`);

    return { success: false, error: error.message };
  }
}

/**
 * Worker pool manager
 */
async function startWorker(workerId) {
  log("info", `🚀 Worker ${workerId} started`);

  while (true) {
    // Paid Shopify orders jump the queue so fulfilled revenue starts work immediately.
    const target =
      state.targets.find(
        (candidate) => candidate.status === "pending" && candidate.kind === "shopify-paid-order",
      ) ||
      state.targets.find(
        (candidate) => candidate.status === "pending" && candidate.kind === "stripe-charge",
      ) ||
      state.targets.find((candidate) => candidate.status === "pending");

    if (!target) {
      // No more targets, wait a bit
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    await harvestTarget(target, workerId);

    // Small delay between tasks
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Initialize harvester
 */
async function initialize() {
  log("info", "🐺 ALPHABET HARVESTER starting...");
  log("info", `Workers: ${CONFIG.workers}`);
  log("info", `Port: ${CONFIG.port}`);
  log(
    githubToken ? "success" : "warning",
    githubToken
      ? "🔐 GitHub API token detected; authenticated GitHub requests enabled"
      : "⚠️ No GitHub API token detected; GitHub requests use public rate limits",
  );
  log(
    huggingFaceToken ? "success" : "warning",
    huggingFaceToken
      ? "🧠 Hugging Face token detected; gated HF model requests enabled"
      : "⚠️ No Hugging Face token detected; gated HF model requests stay locked",
  );
  log(
    shopifyApiSecret ? "success" : "warning",
    shopifyApiSecret
      ? "🛍️ Shopify webhook HMAC auth enabled"
      : "⚠️ SHOPIFY_API_SECRET missing; /api/webhooks/shopify returns 503 until configured",
  );
  log(
    stripeConfig.configured ? "success" : "warning",
    stripeConfig.envSecretKey
      ? "💳 Stripe API secret detected in runtime env; health checks and sync are enabled"
      : stripeConfig.keyVaultConfigured
        ? `💳 Stripe secret will be resolved directly from Key Vault ${stripeConfig.keyVaultName}`
        : "⚠️ Stripe secret is not configured; /api/stripe/* returns 503 until configured",
  );
  log(
    revolutConfig.configured ? "success" : "warning",
    revolutConfig.configured
      ? `🔐 Revolut signer refresh armed via ${revolutConfig.signerBaseUrl}${revolutConfig.signerPath} with client_assertion_type fixed and client_id ${revolutConfig.clientId ? "fallback enabled" : "fallback disabled"}`
      : "⚠️ Revolut signer refresh is not configured; /api/revolut/* returns 503 until signer URL, signer token, and refresh token are set",
  );
  log(
    "info",
    `📘 Loaded canonical note ${REVOLUT_CANONICAL_NOTE.id}: client_assertion_type fixed, client_id optional fallback`,
  );
  log(
    getHarvesterPublicUrl() ? "success" : "warning",
    getHarvesterPublicUrl()
      ? `🌐 Harvester public URL: ${getHarvesterPublicUrl()}`
      : "⚠️ HARVESTER_PUBLIC_URL missing; responses fall back to request host",
  );
  log(
    databaseConfig.configured ? "success" : "warning",
    databaseConfig.configured
      ? `🗄️ PostgreSQL target configured: ${databaseConfig.connectionLabel}`
      : "⚠️ DATABASE_* env vars missing; webhook receipts stay memory-only",
  );

  if (databaseConfig.configured) {
    await initializeDatabase();
  }

  if (stripeConfig.configured) {
    try {
      const stripeHealth = await runStripeHealthCheck();
      log(
        "success",
        `💳 Stripe API ready: ${stripeHealth.accountId} (livemode=${stripeHealth.livemode})`,
      );
    } catch (error) {
      state.stripe.lastError = error.message;
      state.stripe.lastUpdated = new Date().toISOString();
      log("warning", `💳 Stripe startup health check failed: ${error.message}`);
    }
  }

  // Load targets
  state.targets = [...DEFAULT_TARGETS];
  log("info", `Loaded ${state.targets.length} targets`);

  // Start workers
  for (let i = 1; i <= CONFIG.workers; i++) {
    const worker = startWorker(i);
    state.workers.push(worker);
  }

  log("success", `✅ ${CONFIG.workers} workers active`);
}

// ============ REST API ============

app.post(
  "/api/webhooks/shopify",
  express.raw({ type: "application/json", limit: "2mb" }),
  authenticateShopifyWebhook,
  async (req, res) => {
    let payload;

    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid Shopify JSON payload" });
    }

    const topic = (req.get("x-shopify-topic") || "unknown").toLowerCase();
    const shop = req.get("x-shopify-shop-domain") || payload?.domain || "unknown";
    const webhookId = req.get("x-shopify-webhook-id") || null;

    state.shopify.lastError = null;
    state.shopify.lastUpdated = new Date().toISOString();

    if (!isPaidShopifyOrder(topic, payload)) {
      log(
        "info",
        `🛍️ Shopify webhook ignored: topic=${topic} shop=${shop} financial_status=${payload?.financial_status || "unknown"}`,
      );

      return res.status(202).json({
        success: true,
        queued: false,
        topic,
        shop,
        reason: "Order is not paid yet",
        financialStatus: payload?.financial_status || "unknown",
      });
    }

    const summary = summarizeShopifyOrder(payload, topic, shop, webhookId);

    try {
      await ensureDatabaseReady(`Shopify order ${summary.orderName}`);
      await persistQueuedShopifyOrder(summary, payload);
    } catch (error) {
      state.shopify.lastError = error.message;
      state.shopify.lastUpdated = new Date().toISOString();
      log(
        "error",
        `🛍️ Shopify webhook persistence failed for ${summary.orderName}: ${error.message}`,
      );
      return res.status(503).json({
        error: "Shopify persistence unavailable",
        detail: error.message,
      });
    }

    const queueResult = enqueueTarget(createShopifyOrderWorkItem(summary));

    if (queueResult.queued) {
      log(
        "success",
        `🛍️ Shopify paid order queued: ${summary.orderName} from ${summary.shop}; Alphabet fer af stað sjálfkrafa`,
      );
    } else {
      log(
        "warning",
        `🛍️ Shopify paid order already queued: ${summary.orderName} from ${summary.shop}`,
      );
    }

    return res.status(202).json({
      success: true,
      queued: queueResult.queued,
      topic,
      shop,
      webhookId,
      orderId: summary.orderId,
      orderName: summary.orderName,
      financialStatus: summary.financialStatus,
      target: queueResult.target,
      receivedAt: new Date().toISOString(),
    });
  },
);

app.use(express.json());

app.post("/api/webhooks/revolut-merchant", async (req, res) => {
  const alphabetSource = normalizeAlphabetSource(req);

  if (alphabetSource !== REVOLUT_MERCHANT_BACKFILL_SOURCE) {
    return res.status(202).json({
      success: true,
      ignored: true,
      queued: false,
      expectedSource: REVOLUT_MERCHANT_BACKFILL_SOURCE,
      publicUrl: getHarvesterPublicUrl(req),
      receivedSource: alphabetSource || null,
      webhookUrl: getRevolutMerchantWebhookUrl(req),
    });
  }

  return handleStripeSyncRequest(req, res);
});

async function handleStripeSyncRequest(req, res) {
  if (!stripeConfig.configured) {
    return res.status(503).json({
      error: "Stripe secret is not configured",
      keyVaultName: stripeConfig.keyVaultName,
      publicUrl: getHarvesterPublicUrl(req),
      secretName: stripeConfig.secretName,
      webhookUrl: getRevolutMerchantWebhookUrl(req),
    });
  }

  const alphabetSource = normalizeAlphabetSource(req);
  const isRevolutMerchantBackfill = alphabetSource === REVOLUT_MERCHANT_BACKFILL_SOURCE;
  const publicUrl = getHarvesterPublicUrl(req);
  const webhookUrl = getRevolutMerchantWebhookUrl(req);

  if (isRevolutMerchantBackfill) {
    state.stripe.merchantBackfill.active = false;
    state.stripe.merchantBackfill.lastEventType =
      req.get("x-revolut-event") || req.body?.type || "manual-backfill";
    state.stripe.merchantBackfill.lastRequestedAt = new Date().toISOString();
    state.stripe.merchantBackfill.lastWebhookId =
      req.get("x-revolut-webhook-id") || req.get("x-request-id") || req.body?.id || null;
    state.stripe.publicUrl = publicUrl || state.stripe.publicUrl;
    state.stripe.merchantWebhookUrl = webhookUrl || state.stripe.merchantWebhookUrl;
  }

  try {
    await ensureDatabaseReady("Stripe initial sync");

    const limit = clampStripeSyncLimit(req.body?.limit ?? req.query.limit);
    const payload = isRevolutMerchantBackfill
      ? await fetchAllStripeCharges(limit)
      : await fetchStripeCharges(limit);
    const charges = Array.isArray(payload?.data) ? payload.data : [];
    let queued = 0;
    let existing = 0;
    const summaries = [];

    for (const charge of charges) {
      const summary = summarizeStripeCharge(charge);
      const queueResult = enqueueTarget(createStripeChargeWorkItem(summary));

      await persistQueuedStripeCharge(summary, charge);
      summaries.push(summary);

      if (queueResult.queued) {
        queued++;
      } else {
        existing++;
      }
    }

    state.stripe.lastSyncAt = new Date().toISOString();
    state.stripe.lastSyncPages = Number(payload?.pagesFetched || 1);
    state.stripe.lastSyncQueued = queued;
    state.stripe.lastSyncedPayments = charges.length;
    state.stripe.lastError = null;
    state.stripe.lastUpdated = state.stripe.lastSyncAt;

    if (isRevolutMerchantBackfill) {
      state.stripe.merchantBackfill.active = charges.length > 0;
      state.stripe.merchantBackfill.lastQueued = queued;
    }

    const persistedCount = await refreshStripePaymentCount();

    log(
      "success",
      `💳 Stripe initial sync fetched ${charges.length} charges; queued ${queued} for ${state.stats.workers} workers`,
    );

    if (isRevolutMerchantBackfill) {
      log(
        "success",
        `💶 Revolut Merchant backfill accepted for ${REVOLUT_MERCHANT_TARGET_ASSETS_EUR} EUR target assets via ${publicUrl || "request-host"}`,
      );
    }

    return res.status(202).json({
      success: true,
      fetched: charges.length,
      queued,
      existing,
      blueprintSyncRef: BLUEPRINT_SYNC_REF,
      merchantBackfill: isRevolutMerchantBackfill ? state.stripe.merchantBackfill : undefined,
      pagesFetched: state.stripe.lastSyncPages,
      workerCount: state.stats.workers,
      publicUrl,
      source: alphabetSource || "manual",
      targetAssetsEur: isRevolutMerchantBackfill ? REVOLUT_MERCHANT_TARGET_ASSETS_EUR : null,
      persistedCount,
      webhookUrl,
      charges: summaries,
    });
  } catch (error) {
    if (isRevolutMerchantBackfill) {
      state.stripe.merchantBackfill.active = false;
      state.stripe.merchantBackfill.lastQueued = 0;
    }

    state.stripe.lastError = error.message;
    state.stripe.lastUpdated = new Date().toISOString();
    log("error", `💳 Stripe initial sync failed: ${error.message}`);

    return res.status(503).json({
      error: "Stripe sync failed",
      blueprintSyncRef: BLUEPRINT_SYNC_REF,
      detail: error.message,
      merchantBackfill: isRevolutMerchantBackfill ? state.stripe.merchantBackfill : undefined,
      publicUrl,
      source: alphabetSource || "manual",
      targetAssetsEur: isRevolutMerchantBackfill ? REVOLUT_MERCHANT_TARGET_ASSETS_EUR : null,
      webhookUrl,
    });
  }
}

async function handleRevolutRefreshRequest(req, res) {
  try {
    const result = await refreshRevolutAccessToken();

    log(
      "success",
      `🔐 Revolut refresh succeeded via signer flow (${state.revolut.clientIdMode === "fallback" ? "client_id fallback on" : "JWT sub only"})`,
    );

    return res.json({
      success: true,
      canonicalNote: REVOLUT_CANONICAL_NOTE,
      result,
    });
  } catch (error) {
    state.revolut.lastError = error.message;
    state.revolut.lastUpdated = new Date().toISOString();
    log("error", `🔐 Revolut refresh failed: ${error.message}`);

    return res.status(503).json({
      error: "Revolut refresh failed",
      detail: error.message,
      canonicalNote: REVOLUT_CANONICAL_NOTE,
      clientIdMode: state.revolut.clientIdMode,
      configured: state.revolut.configured,
      revolutBaseUrl: state.revolut.revolutBaseUrl,
      signerBaseUrl: state.revolut.signerBaseUrl,
    });
  }
}

app.get("/api/stripe/health", async (req, res) => {
  if (!stripeConfig.configured) {
    return res.status(503).json({ error: "STRIPE_SECRET_KEY is not configured" });
  }

  try {
    const stripe = await runStripeHealthCheck();

    if (databasePool) {
      await ensureDatabaseReady("Stripe health check");
      await refreshStripePaymentCount();
    }

    return res.json({
      status: "ok",
      stripe,
      database: {
        connected: state.database.connected,
        persistenceReady: state.database.persistenceReady,
        table: "alphabet_stripe_payments",
        persistedCount: state.stripe.persistedCount,
      },
    });
  } catch (error) {
    state.stripe.lastError = error.message;
    state.stripe.lastUpdated = new Date().toISOString();

    return res.status(503).json({
      status: "degraded",
      error: error.message,
      database: {
        connected: state.database.connected,
        persistenceReady: state.database.persistenceReady,
        table: "alphabet_stripe_payments",
        persistedCount: state.stripe.persistedCount,
      },
    });
  }
});

app.get("/api/stripe/status", async (req, res) => {
  if (databasePool && state.database.connected) {
    try {
      await refreshStripePaymentCount();
    } catch (error) {
      state.stripe.lastError = error.message;
      state.stripe.lastUpdated = new Date().toISOString();
    }
  }

  res.json({
    ...state.stripe,
    database: {
      connected: state.database.connected,
      persistenceReady: state.database.persistenceReady,
      table: "alphabet_stripe_payments",
      persistedCount: state.stripe.persistedCount,
    },
  });
});

app.get("/api/stripe/sync", handleStripeSyncRequest);
app.post("/api/stripe/sync", handleStripeSyncRequest);
app.post("/api/stripe/fetch-orders", handleStripeSyncRequest);
app.get("/api/revolut/status", (req, res) => {
  res.json({ ...state.revolut });
});
app.get("/api/revolut/refresh-token", handleRevolutRefreshRequest);
app.post("/api/revolut/refresh-token", handleRevolutRefreshRequest);

// Health check
app.get("/api/health", (req, res) => {
  const healthy = !state.database.configured || state.database.connected;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptime: process.uptime(),
    database: state.database,
    stripe: {
      publicUrl: state.stripe.publicUrl,
      merchantBackfill: state.stripe.merchantBackfill,
      merchantWebhookUrl: state.stripe.merchantWebhookUrl,
      secretPresent: state.stripe.secretPresent,
      secretSource: state.stripe.secretSource,
      sovereignStatus: SOVEREIGN_STATUS_HEADER_VALUE,
      blueprintSyncRef: BLUEPRINT_SYNC_REF,
      accountId: state.stripe.accountId,
      keyVaultName: state.stripe.keyVaultName,
      livemode: state.stripe.livemode,
      persistedCount: state.stripe.persistedCount,
      lastError: state.stripe.lastError,
      lastHealthCheck: state.stripe.lastHealthCheck,
      lastSecretResolvedAt: state.stripe.lastSecretResolvedAt,
      lastSyncAt: state.stripe.lastSyncAt,
    },
    revolut: {
      configured: state.revolut.configured,
      signerConfigured: state.revolut.signerConfigured,
      signerBaseUrl: state.revolut.signerBaseUrl,
      signerPath: state.revolut.signerPath,
      revolutBaseUrl: state.revolut.revolutBaseUrl,
      refreshTokenPresent: state.revolut.refreshTokenPresent,
      accessTokenPresent: state.revolut.accessTokenPresent,
      accessTokenExpiresAt: state.revolut.accessTokenExpiresAt,
      clientAssertionType: state.revolut.clientAssertionType,
      clientIdMode: state.revolut.clientIdMode,
      lastAssertionIssuedAt: state.revolut.lastAssertionIssuedAt,
      lastAssertionExpiresAt: state.revolut.lastAssertionExpiresAt,
      lastRefreshAt: state.revolut.lastRefreshAt,
      lastError: state.revolut.lastError,
      canonicalNote: state.revolut.canonicalNote,
    },
  });
});

app.get("/api/database/status", (req, res) => {
  const healthy = !state.database.configured || state.database.connected;

  res.status(healthy ? 200 : 503).json({
    ...state.database,
    table: "alphabet_shopify_orders",
  });
});

// Get targets and stats
app.get("/api/targets", (req, res) => {
  res.json({
    targets: state.targets,
    stats: state.stats,
  });
});

app.get("/api/github/status", (req, res) => {
  res.json({
    tokenPresent: state.github.tokenPresent,
    authMode: state.github.authMode,
    rateLimit: state.github.rateLimit,
    lastError: state.github.lastError,
    lastUpdated: state.github.lastUpdated,
  });
});

app.get("/api/huggingface/status", (req, res) => {
  res.json({
    tokenPresent: state.huggingFace.tokenPresent,
    authMode: state.huggingFace.authMode,
    lastError: state.huggingFace.lastError,
    lastUpdated: state.huggingFace.lastUpdated,
  });
});

// Remove failed targets from the in-memory list
app.post("/api/targets/cleanup-failed", (req, res) => {
  const failedTargets = state.targets.filter((target) => target.status === "failed");

  if (failedTargets.length === 0) {
    return res.json({
      success: true,
      removed: 0,
      targets: state.targets,
      stats: state.stats,
    });
  }

  state.targets = state.targets.filter((target) => target.status !== "failed");
  state.stats.failed = 0;

  log("warning", `🧹 Removed ${failedTargets.length} failed targets from state`);

  res.json({
    success: true,
    removed: failedTargets.length,
    targets: state.targets,
    stats: state.stats,
  });
});

// Get logs (historical)
app.get("/api/logs", (req, res) => {
  const limit = parseInt(req.query.limit || "100", 10);
  res.json({
    logs: state.logs.slice(-limit),
  });
});

// Add new target
app.post("/api/targets", (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  const target = {
    id: randomUUID(),
    url,
    status: "pending",
    progress: 0,
  };

  state.targets.push(target);
  log("info", `➕ Added new target: ${url}`);

  res.json({ success: true, target });
});

// Update worker count (dynamic scaling)
app.post("/api/workers/scale", (req, res) => {
  const { workers } = req.body;

  if (!workers || workers < 1 || workers > 20) {
    return res.status(400).json({ error: "workers must be between 1 and 20" });
  }

  const oldCount = CONFIG.workers;
  CONFIG.workers = workers;
  state.stats.workers = workers;

  log("warning", `⚙️ Scaling workers: ${oldCount} → ${workers}`);

  // Start new workers if needed
  if (workers > oldCount) {
    for (let i = oldCount + 1; i <= workers; i++) {
      const worker = startWorker(i);
      state.workers.push(worker);
    }
  }

  res.json({ success: true, workers: CONFIG.workers });
});

// ============ WebSocket ============

wss.on("connection", (ws) => {
  log("info", "🔌 New WebSocket client connected");

  // Send recent logs on connect
  const recentLogs = state.logs.slice(-50);
  recentLogs.forEach((logEntry) => {
    ws.send(JSON.stringify(logEntry));
  });

  ws.on("close", () => {
    log("info", "🔌 WebSocket client disconnected");
  });
});

// ============ START SERVER ============

server.listen(CONFIG.port, "0.0.0.0", () => {
  log("success", `✅ Server running on http://0.0.0.0:${CONFIG.port}`);
  log("success", `✅ WebSocket available on ws://0.0.0.0:${CONFIG.port}/api/logs/stream`);
  initialize().catch((error) => {
    log("error", `❌ Startup aborted: ${error.message}`);
    setTimeout(() => {
      process.exit(1);
    }, 250);
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log("warning", "⚠️ SIGTERM received, shutting down...");

  server.close(async () => {
    if (databasePool) {
      await databasePool.end();
    }

    log("info", "👋 Server closed");
    process.exit(0);
  });
});
