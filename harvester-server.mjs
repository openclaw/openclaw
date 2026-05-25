#!/usr/bin/env node
/**
 * 🐺 ALPHABET HARVESTER - Web Scraping Engine
 * Keyrir með OpenClaw sem grunn
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import express from "express";
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
  workers: Number.parseInt(process.env.HARVESTER_WORKERS || "15", 10),
  port: Number.parseInt(process.env.HARVESTER_PORT || "8080", 10),
  retryDelay: 5000,
  requestTimeout: 30000,
  databaseConnectTimeout: Number.parseInt(process.env.HARVESTER_DB_CONNECT_TIMEOUT || "10000", 10),
  databaseStatementTimeout: Number.parseInt(
    process.env.HARVESTER_DB_STATEMENT_TIMEOUT || "15000",
    10,
  ),
};
const EMPIRE_MARKET_SOURCE = "CoinGecko";
const DEFAULT_EMPIRE_MARKET_API_BASE_URL = "https://api.coingecko.com/api/v3";
const DEFAULT_EMPIRE_MARKET_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_PAYPAL_RECOVERY_PRINCIPAL_EUR = 202000000;
const DEFAULT_PAYPAL_RECOVERY_APR = 0.12;
const DEFAULT_PAYPAL_RECOVERY_TARGET_DATE = "2026-12-31T23:59:59Z";
const DEFAULT_PAYPAL_SANDBOX_API_BASE_URL = "https://api-m.sandbox.paypal.com";
const DEFAULT_BTC_BACKSTOP_HOLDINGS = 2400;
const EMPIRE_MARKET_ASSET_DEFINITIONS = Object.freeze([
  {
    id: "bitcoin",
    symbol: "BTC",
    label: "Bitcoin Backstop",
    envNames: ["ALPHABET_BTC_HOLDINGS", "BTC_BACKSTOP_HOLDINGS"],
    defaultHoldings: DEFAULT_BTC_BACKSTOP_HOLDINGS,
  },
  {
    id: "ethereum",
    symbol: "ETH",
    label: "Ethereum Stack",
    envNames: ["ALPHABET_ETH_HOLDINGS", "ETH_HOLDINGS"],
    defaultHoldings: 0,
  },
  {
    id: "pi-network",
    symbol: "PI",
    label: "Pi Reserve",
    envNames: ["ALPHABET_PI_HOLDINGS", "PI_HOLDINGS"],
    defaultHoldings: 0,
  },
]);

function readNonEmptyEnv(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return "";
}

function parseConfiguredNumber(rawValue, fallbackValue = 0) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return { value: fallbackValue, configured: false };
  }

  const parsedValue = Number.parseFloat(String(rawValue).replace(/,/gu, ""));

  if (!Number.isFinite(parsedValue)) {
    return { value: fallbackValue, configured: false };
  }

  return {
    value: parsedValue,
    configured: true,
  };
}

function parseConfiguredBoolean(rawValue, fallbackValue = false) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return { value: fallbackValue, configured: false };
  }

  const normalizedValue = String(rawValue).trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return { value: true, configured: true };
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return { value: false, configured: true };
  }

  return { value: fallbackValue, configured: false };
}

function readOptionalPem(names) {
  const rawValue = readNonEmptyEnv(names);

  return rawValue ? rawValue.replace(/\\n/gu, "\n") : "";
}

const REVOLUT_MERCHANT_BACKFILL_SOURCE = "revolut-merchant-backfill";
const REVOLUT_MERCHANT_ORDER_POLL_SOURCE = "revolut-merchant-order-poll";
const REVOLUT_MERCHANT_TARGET_ASSETS_EUR = 340000000;
const REVOLUT_CONFIRMED_BACKFILL_EVENT = Object.freeze({
  createdAt: "2026-05-13T18:45:00Z",
  currency: "EUR",
  eventId: "evt_340m_norm_001",
  eventType: "merchant.order.completed",
  merchantOrderReference: "alphabet-340m-order",
  merchantReference: "alphabet-direct-340m",
  orderId: "ord_340m_norm_001",
  paymentId: "pay_340m_norm_001",
  paymentStatus: "captured",
  settlementCurrency: "EUR",
  settlementStatus: "settled",
  settledAt: "2026-05-13T18:45:30Z",
  webhookId: "evt-revolut-normalized-340m",
});
const STRIPE_SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const REVOLUT_CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const DEFAULT_REVOLUT_BASE_URL = "https://b2b.revolut.com";
const DEFAULT_REVOLUT_MERCHANT_API_BASE_URL = "https://merchant.revolut.com";
const DEFAULT_REVOLUT_MERCHANT_CREATE_ORDER_PATH = "/orders";
const DEFAULT_REVOLUT_MERCHANT_API_VERSION = "2026-04-20";
const LEGACY_REVOLUT_MERCHANT_CREATE_ORDER_PATH = "/api/1.0/orders";
const DEFAULT_REVOLUT_SIGNER_PATH = "/internal/auth/revolut/client-assertion";
const DEFAULT_AIRTABLE_API_BASE_URL = "https://api.airtable.com";
const DEFAULT_AIRTABLE_TRANSFER_VIEW = "Markaðshlutafélagastýring";
const DEFAULT_AIRTABLE_TRANSFER_PAGE_SIZE = 100;
const DEFAULT_AIRTABLE_TRANSFER_MAX_RECORDS = 100;
const DEFAULT_REVOLUT_TRANSFER_CHARGE_BEARER = "shared";
const DEFAULT_REVOLUT_TRANSFER_EXECUTION_BATCH_SIZE = 10;
const DEFAULT_REVOLUT_TRANSFER_REFERENCE_PREFIX = "Airtable";
const REVOLUT_BUSINESS_TRANSFER_EXECUTION_SOURCE = "revolut-business-pay-execution";
const REVOLUT_BUSINESS_TRANSFER_PREPARE_SOURCE = "airtable-revolut-business-transfer-prepare";
const REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE = "alphabet_revolut_business_transfer_queue";
const REVOLUT_BUSINESS_SOURCE_ACCOUNT_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
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

function createRuntimeConfig() {
  const stealthMode = parseConfiguredBoolean(
    readNonEmptyEnv(["HARVESTER_STEALTH_MODE", "ALPACORE_STEALTH_MODE"]),
    false,
  ).value;
  const loadDefaultTargets = parseConfiguredBoolean(
    readNonEmptyEnv(["HARVESTER_LOAD_DEFAULT_TARGETS"]),
    !stealthMode,
  ).value;
  const allowStartupNetworkActions = parseConfiguredBoolean(
    readNonEmptyEnv(["HARVESTER_ALLOW_STARTUP_NETWORK", "HARVESTER_ENABLE_STARTUP_NETWORK"]),
    !stealthMode,
  ).value;

  return {
    mode: stealthMode ? "stealth" : "standard",
    stealthMode,
    loadDefaultTargets,
    allowStartupNetworkActions,
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

function getPayPalSandboxWebhookUrl(req = null) {
  const publicUrl = getHarvesterPublicUrl(req);
  return publicUrl ? `${publicUrl}/api/webhooks/paypal-sandbox` : null;
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
const runtimeConfig = createRuntimeConfig();

function createEmpireConfig() {
  const parsedCacheTtlMs = Number.parseInt(
    readNonEmptyEnv(["EMPIRE_MARKET_CACHE_TTL_MS", "HARVESTER_EMPIRE_MARKET_CACHE_TTL_MS"]),
    10,
  );
  const parsedRevolutConfirmedTotal = parseConfiguredNumber(
    readNonEmptyEnv(["ALPHABET_REVOLUT_CONFIRMED_TOTAL_EUR", "REVOLUT_CONFIRMED_TOTAL_EUR"]),
    0,
  );
  const parsedPaypalRecoveryPrincipal = parseConfiguredNumber(
    readNonEmptyEnv(["ALPHABET_PAYPAL_RECOVERY_PRINCIPAL_EUR", "PAYPAL_RECOVERY_PRINCIPAL_EUR"]),
    DEFAULT_PAYPAL_RECOVERY_PRINCIPAL_EUR,
  );
  const parsedPaypalRecoveryApr = parseConfiguredNumber(
    readNonEmptyEnv(["ALPHABET_PAYPAL_RECOVERY_APR", "PAYPAL_RECOVERY_APR"]),
    DEFAULT_PAYPAL_RECOVERY_APR,
  );
  const assets = EMPIRE_MARKET_ASSET_DEFINITIONS.map((asset) => {
    const parsedHoldings = parseConfiguredNumber(
      readNonEmptyEnv(asset.envNames),
      asset.defaultHoldings,
    );

    return Object.assign(asset, {
      holdings: parsedHoldings.value,
      holdingsConfigured: parsedHoldings.configured || asset.defaultHoldings > 0,
    });
  });

  return {
    assets,
    marketApiBaseUrl:
      normalizeBaseUrl(
        readNonEmptyEnv(["EMPIRE_MARKET_API_BASE_URL", "HARVESTER_EMPIRE_MARKET_API_BASE_URL"]),
      ) || DEFAULT_EMPIRE_MARKET_API_BASE_URL,
    marketCacheTtlMs:
      Number.isFinite(parsedCacheTtlMs) && parsedCacheTtlMs > 0
        ? parsedCacheTtlMs
        : DEFAULT_EMPIRE_MARKET_CACHE_TTL_MS,
    paypalRecoveryApr: parsedPaypalRecoveryApr.value,
    paypalRecoveryPrincipalEur: parsedPaypalRecoveryPrincipal.value,
    revolutConfirmedTotalConfigured: parsedRevolutConfirmedTotal.configured,
    revolutConfirmedTotalEur: parsedRevolutConfirmedTotal.value,
    paypalRecoveryTargetDate:
      readNonEmptyEnv(["ALPHABET_PAYPAL_RECOVERY_TARGET_DATE", "PAYPAL_RECOVERY_TARGET_DATE"]) ||
      DEFAULT_PAYPAL_RECOVERY_TARGET_DATE,
  };
}

const empireConfig = createEmpireConfig();
const empireMarketCache = {
  fetchedAtMs: 0,
  payload: null,
};

function createStripeConfig() {
  const envSecretKey = readNonEmptyEnv(["STRIPE_SECRET_KEY", "STRIPE_API_KEY"]);
  const apiBaseUrl = readNonEmptyEnv(["STRIPE_API_BASE_URL"]) || "https://api.stripe.com/v1";
  const healthCheckPath =
    normalizePath(
      readNonEmptyEnv(["STRIPE_HEALTHCHECK_PATH", "HARVESTER_STRIPE_HEALTHCHECK_PATH"]),
      "/balance",
    ) || "/balance";
  const syncLimitValue =
    readNonEmptyEnv(["STRIPE_SYNC_LIMIT", "HARVESTER_STRIPE_SYNC_LIMIT"]) || "15";
  const secretName =
    readNonEmptyEnv(["STRIPE_SECRET_KEY_SECRET_NAME", "HARVESTER_STRIPE_SECRET_NAME"]) ||
    "STRIPE-SECRET-KEY";
  const parsedSyncLimit = Number.parseInt(syncLimitValue, 10);
  const keyVaultUrl = serviceConfig.keyVaultUrl;
  const keyVaultName = keyVaultUrl ? keyVaultUrl.replace(/^https:\/\//u, "").split(".")[0] : null;

  return {
    configured: Boolean(envSecretKey || keyVaultUrl),
    envSecretKey,
    apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
    healthCheckPath,
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

function createPayPalSandboxConfig() {
  const apiBaseUrl =
    normalizeBaseUrl(
      readNonEmptyEnv(["PAYPAL_SANDBOX_API_BASE_URL", "HARVESTER_PAYPAL_SANDBOX_API_BASE_URL"]) ||
        DEFAULT_PAYPAL_SANDBOX_API_BASE_URL,
    ) || DEFAULT_PAYPAL_SANDBOX_API_BASE_URL;
  const clientId = readNonEmptyEnv([
    "PAYPAL_SANDBOX_CLIENT_ID",
    "HARVESTER_PAYPAL_SANDBOX_CLIENT_ID",
  ]);
  const clientSecret = readNonEmptyEnv([
    "PAYPAL_SANDBOX_CLIENT_SECRET",
    "HARVESTER_PAYPAL_SANDBOX_CLIENT_SECRET",
  ]);
  const webhookId = readNonEmptyEnv([
    "PAYPAL_SANDBOX_WEBHOOK_ID",
    "HARVESTER_PAYPAL_SANDBOX_WEBHOOK_ID",
  ]);

  return {
    apiBaseUrl,
    clientId,
    clientSecret,
    configured: Boolean(apiBaseUrl && clientId && clientSecret && webhookId),
    credentialsConfigured: Boolean(clientId && clientSecret),
    environment: apiBaseUrl.includes("sandbox") ? "sandbox" : "custom",
    webhookConfigured: Boolean(webhookId),
    webhookId,
  };
}

const paypalSandboxConfig = createPayPalSandboxConfig();
const paypalSandboxAccessTokenCache = {
  accessToken: "",
  expiresAtMs: 0,
  fetchedAtMs: 0,
};

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

function createRevolutMerchantConfig() {
  const configuredCreateOrderPath = readNonEmptyEnv([
    "REVOLUT_MERCHANT_CREATE_ORDER_PATH",
    "HARVESTER_REVOLUT_MERCHANT_CREATE_ORDER_PATH",
  ]);
  const apiBaseUrl = normalizeBaseUrl(
    readNonEmptyEnv([
      "REVOLUT_MERCHANT_API_BASE_URL",
      "HARVESTER_REVOLUT_MERCHANT_API_BASE_URL",
      "REVOLUT_API_BASE_URL",
    ]) || DEFAULT_REVOLUT_MERCHANT_API_BASE_URL,
  );
  const apiKey = readNonEmptyEnv([
    "REVOLUT_MERCHANT_API_KEY",
    "HARVESTER_REVOLUT_MERCHANT_API_KEY",
    "REVOLUT_API_SECRET",
  ]);
  const apiVersion =
    readNonEmptyEnv(["REVOLUT_MERCHANT_API_VERSION", "HARVESTER_REVOLUT_MERCHANT_API_VERSION"]) ||
    DEFAULT_REVOLUT_MERCHANT_API_VERSION;
  const createOrderPath = normalizePath(
    configuredCreateOrderPath,
    DEFAULT_REVOLUT_MERCHANT_CREATE_ORDER_PATH,
  );

  return {
    apiBaseUrl,
    apiKey,
    apiVersion,
    createOrderPath,
    createOrderPathExplicit: Boolean(configuredCreateOrderPath),
    configured: Boolean(apiBaseUrl && apiKey && apiVersion),
  };
}

const revolutMerchantConfig = createRevolutMerchantConfig();

function createAirtableTransferConfig() {
  const apiBaseUrl = normalizeBaseUrl(
    readNonEmptyEnv(["AIRTABLE_API_BASE_URL", "HARVESTER_AIRTABLE_API_BASE_URL"]) ||
      DEFAULT_AIRTABLE_API_BASE_URL,
  );
  const apiKey = readNonEmptyEnv([
    "AIRTABLE_API_TOKEN",
    "HARVESTER_AIRTABLE_API_TOKEN",
    "AIRTABLE_ENTERPRISE_KEY",
    "HARVESTER_AIRTABLE_ENTERPRISE_KEY",
  ]);
  const baseId = readNonEmptyEnv([
    "AIRTABLE_TRANSFER_BASE_ID",
    "HARVESTER_AIRTABLE_TRANSFER_BASE_ID",
    "AIRTABLE_BASE_ID",
  ]);
  const tableIdOrName = readNonEmptyEnv([
    "AIRTABLE_TRANSFER_TABLE_ID_OR_NAME",
    "HARVESTER_AIRTABLE_TRANSFER_TABLE_ID_OR_NAME",
    "AIRTABLE_TABLE_ID_OR_NAME",
  ]);
  const view =
    readNonEmptyEnv(["AIRTABLE_TRANSFER_VIEW", "HARVESTER_AIRTABLE_TRANSFER_VIEW"]) ||
    DEFAULT_AIRTABLE_TRANSFER_VIEW;
  const pageSize = Math.min(
    Math.max(
      Number.parseInt(
        readNonEmptyEnv(["AIRTABLE_TRANSFER_PAGE_SIZE", "HARVESTER_AIRTABLE_TRANSFER_PAGE_SIZE"]) ||
          `${DEFAULT_AIRTABLE_TRANSFER_PAGE_SIZE}`,
        10,
      ) || DEFAULT_AIRTABLE_TRANSFER_PAGE_SIZE,
      1,
    ),
    100,
  );
  const maxRecords = Math.min(
    Math.max(
      Number.parseInt(
        readNonEmptyEnv([
          "AIRTABLE_TRANSFER_MAX_RECORDS",
          "HARVESTER_AIRTABLE_TRANSFER_MAX_RECORDS",
        ]) || `${DEFAULT_AIRTABLE_TRANSFER_MAX_RECORDS}`,
        10,
      ) || DEFAULT_AIRTABLE_TRANSFER_MAX_RECORDS,
      1,
    ),
    500,
  );
  const sourceAccountId = readNonEmptyEnv([
    "REVOLUT_TRANSFER_SOURCE_ACCOUNT_ID",
    "HARVESTER_REVOLUT_TRANSFER_SOURCE_ACCOUNT_ID",
  ]);
  const defaultCounterpartyId = readNonEmptyEnv([
    "REVOLUT_TRANSFER_COUNTERPARTY_ID",
    "HARVESTER_REVOLUT_TRANSFER_COUNTERPARTY_ID",
  ]);
  const defaultReceiverAccountId = readNonEmptyEnv([
    "REVOLUT_TRANSFER_RECEIVER_ACCOUNT_ID",
    "HARVESTER_REVOLUT_TRANSFER_RECEIVER_ACCOUNT_ID",
  ]);
  const defaultReceiverCardId = readNonEmptyEnv([
    "REVOLUT_TRANSFER_RECEIVER_CARD_ID",
    "HARVESTER_REVOLUT_TRANSFER_RECEIVER_CARD_ID",
  ]);
  const defaultCurrency =
    readNonEmptyEnv(["REVOLUT_TRANSFER_CURRENCY", "HARVESTER_REVOLUT_TRANSFER_CURRENCY"]) || "EUR";
  const defaultReferencePrefix =
    readNonEmptyEnv([
      "REVOLUT_TRANSFER_REFERENCE_PREFIX",
      "HARVESTER_REVOLUT_TRANSFER_REFERENCE_PREFIX",
    ]) || DEFAULT_REVOLUT_TRANSFER_REFERENCE_PREFIX;
  const transferReasonCode = readNonEmptyEnv([
    "REVOLUT_TRANSFER_REASON_CODE",
    "HARVESTER_REVOLUT_TRANSFER_REASON_CODE",
  ]);
  const chargeBearer = readNonEmptyEnv([
    "REVOLUT_TRANSFER_CHARGE_BEARER",
    "HARVESTER_REVOLUT_TRANSFER_CHARGE_BEARER",
  ]);

  return {
    apiBaseUrl,
    apiKey,
    baseId,
    tableIdOrName,
    view,
    pageSize,
    maxRecords,
    sourceAccountId,
    defaultCounterpartyId,
    defaultReceiverAccountId,
    defaultReceiverCardId,
    defaultCurrency: defaultCurrency.trim().toUpperCase() || "EUR",
    defaultReferencePrefix,
    transferReasonCode,
    chargeBearer,
    airtableConfigured: Boolean(apiBaseUrl && apiKey && baseId && tableIdOrName),
    draftDefaultsConfigured: Boolean(sourceAccountId),
    configured: Boolean(apiBaseUrl && apiKey && baseId && tableIdOrName && sourceAccountId),
  };
}

const airtableTransferConfig = createAirtableTransferConfig();
const revolutBusinessSourceAccountDiscoveryRuntime = {
  accounts: [],
  inFlightPromise: null,
  lastAttemptAt: null,
  lastError: null,
  lastRequestUrl: null,
  lastStatus: airtableTransferConfig.sourceAccountId
    ? "configured-via-env"
    : revolutConfig.configured
      ? "pending"
      : "unavailable",
  lastTrigger: airtableTransferConfig.sourceAccountId ? "env" : null,
  sourceAccountId: airtableTransferConfig.sourceAccountId || null,
  sourceAccountIdSource: airtableTransferConfig.sourceAccountId ? "env" : null,
  sourceSelectionReason: airtableTransferConfig.sourceAccountId ? "Configured via env" : null,
  successfulAt: null,
};

function isRevolutBusinessSourceAccountConfigurationError(message) {
  return (
    typeof message === "string" &&
    (message.includes("source account") || message.includes("REVOLUT_TRANSFER_SOURCE_ACCOUNT_ID"))
  );
}

function mapRevolutBusinessAccount(account) {
  const id = normalizeTextValue(account?.id);

  if (!id) {
    return null;
  }

  const currency = normalizeTextValue(account?.currency);
  const stateValue = normalizeTextValue(account?.state);
  const typeValue = normalizeTextValue(account?.type);
  const balance = Number(account?.balance);

  return {
    id,
    name: normalizeTextValue(account?.name) || null,
    currency: currency ? currency.toUpperCase() : null,
    state: stateValue ? stateValue.toUpperCase() : null,
    type: typeValue ? typeValue.toUpperCase() : null,
    public: typeof account?.public === "boolean" ? account.public : null,
    balance: Number.isFinite(balance) ? balance : null,
    createdAt: normalizeTimestampValue(account?.created_at ?? account?.createdAt),
    updatedAt: normalizeTimestampValue(account?.updated_at ?? account?.updatedAt),
  };
}

function normalizeRevolutBusinessAccountsPayload(payload) {
  const accounts = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.accounts)
      ? payload.accounts
      : [];

  return accounts.map(mapRevolutBusinessAccount).filter(Boolean);
}

function isSelectableRevolutBusinessAccount(account) {
  if (!account?.id) {
    return false;
  }

  return !["ARCHIVED", "CLOSED", "DELETED", "DISABLED", "INACTIVE"].includes(
    (account.state || "").toUpperCase(),
  );
}

function chooseRevolutBusinessSourceAccount(accounts, preferredCurrency) {
  const eligibleAccounts = accounts.filter(isSelectableRevolutBusinessAccount);
  const normalizedPreferredCurrency = normalizeTextValue(preferredCurrency)?.toUpperCase() || null;
  const preferredCurrencyAccounts = normalizedPreferredCurrency
    ? eligibleAccounts.filter((account) => account.currency === normalizedPreferredCurrency)
    : [];

  if (preferredCurrencyAccounts.length === 1) {
    return {
      account: preferredCurrencyAccounts[0],
      reason: `Unique ${normalizedPreferredCurrency} account discovered`,
      source: "auto-discovered-preferred-currency",
    };
  }

  if (eligibleAccounts.length === 1) {
    return {
      account: eligibleAccounts[0],
      reason: "Single eligible Revolut Business account discovered",
      source: "auto-discovered-single-account",
    };
  }

  if (accounts.length === 1) {
    return {
      account: accounts[0],
      reason: "Single Revolut Business account discovered",
      source: "auto-discovered-single-account",
    };
  }

  if (!accounts.length) {
    return {
      account: null,
      reason: "No Revolut Business accounts were returned by /api/1.0/accounts",
      source: null,
    };
  }

  if (!eligibleAccounts.length) {
    return {
      account: null,
      reason:
        "Discovered Revolut Business accounts did not include an active/selectable source account",
      source: null,
    };
  }

  if (preferredCurrencyAccounts.length > 1) {
    return {
      account: null,
      reason: `Multiple ${normalizedPreferredCurrency} Revolut Business accounts were discovered; set REVOLUT_TRANSFER_SOURCE_ACCOUNT_ID to choose explicitly`,
      source: null,
    };
  }

  return {
    account: null,
    reason:
      "Multiple Revolut Business accounts were discovered; set REVOLUT_TRANSFER_SOURCE_ACCOUNT_ID to choose explicitly",
    source: null,
  };
}

function getRevolutBusinessSourceAccountDiscoveryMode() {
  if (revolutConfig.configured) {
    return "business-refresh";
  }

  if (revolutMerchantConfig.configured) {
    return "merchant-api-fallback";
  }

  return null;
}

function getRevolutBusinessSourceAccountDiscoveryUnavailableMessage() {
  return "REVOLUT_TRANSFER_SOURCE_ACCOUNT_ID is not configured and neither Revolut Business refresh nor Merchant API fallback is available for automatic discovery";
}

function decorateRevolutBusinessSourceAccountSelection(selection, discoveryMode) {
  if (!selection || discoveryMode !== "merchant-api-fallback") {
    return selection;
  }

  const decoratedReason = normalizeTextValue(selection.reason);

  return {
    ...selection,
    reason: decoratedReason
      ? `${decoratedReason} via Merchant API fallback`
      : "Resolved via Merchant API fallback",
    source: selection.source ? `merchant-api-fallback:${selection.source}` : null,
  };
}

function getResolvedRevolutBusinessTransferSourceAccountId() {
  return (
    airtableTransferConfig.sourceAccountId ||
    revolutBusinessSourceAccountDiscoveryRuntime.sourceAccountId ||
    null
  );
}

function getResolvedRevolutBusinessTransferSourceAccountSource() {
  return airtableTransferConfig.sourceAccountId
    ? "env"
    : revolutBusinessSourceAccountDiscoveryRuntime.sourceAccountIdSource;
}

function getResolvedRevolutBusinessTransferSourceAccountReason() {
  return airtableTransferConfig.sourceAccountId
    ? "Configured via env"
    : revolutBusinessSourceAccountDiscoveryRuntime.sourceSelectionReason;
}

function getResolvedAirtableTransferConfig() {
  const sourceAccountId = getResolvedRevolutBusinessTransferSourceAccountId();

  return {
    ...airtableTransferConfig,
    sourceAccountId,
    draftDefaultsConfigured: Boolean(sourceAccountId),
    configured: Boolean(airtableTransferConfig.airtableConfigured && sourceAccountId),
  };
}

function getRevolutBusinessSourceAccountDiscoverySnapshot() {
  return {
    accounts: revolutBusinessSourceAccountDiscoveryRuntime.accounts,
    lastAttemptAt: revolutBusinessSourceAccountDiscoveryRuntime.lastAttemptAt,
    lastDiscoveryAt: revolutBusinessSourceAccountDiscoveryRuntime.successfulAt,
    lastError: revolutBusinessSourceAccountDiscoveryRuntime.lastError,
    requestUrl: revolutBusinessSourceAccountDiscoveryRuntime.lastRequestUrl,
    sourceAccountId: getResolvedRevolutBusinessTransferSourceAccountId(),
    sourceAccountIdSource: getResolvedRevolutBusinessTransferSourceAccountSource(),
    sourceSelectionReason: getResolvedRevolutBusinessTransferSourceAccountReason(),
    status: revolutBusinessSourceAccountDiscoveryRuntime.lastStatus,
    trigger: revolutBusinessSourceAccountDiscoveryRuntime.lastTrigger,
  };
}

function syncRevolutBusinessTransferState() {
  if (!state?.revolutBusinessTransfers) {
    return getResolvedAirtableTransferConfig();
  }

  const resolvedConfig = getResolvedAirtableTransferConfig();
  const discoveryMode = getRevolutBusinessSourceAccountDiscoveryMode();
  const hasResolvedSourceAccountId = Boolean(resolvedConfig.sourceAccountId);
  let configurationError = null;

  if (!databaseConfig.configured) {
    configurationError =
      "DATABASE_* env vars must be configured for the persisted Revolut Business transfer queue";
  } else if (!resolvedConfig.airtableConfigured) {
    configurationError =
      "AIRTABLE_* env vars must be configured to read the Markaðshlutafélagastýring view";
  } else if (!hasResolvedSourceAccountId && !discoveryMode) {
    configurationError = getRevolutBusinessSourceAccountDiscoveryUnavailableMessage();
  } else if (!hasResolvedSourceAccountId) {
    configurationError = revolutBusinessSourceAccountDiscoveryRuntime.lastError;
  }

  state.revolutBusinessTransfers.airtableConfigured = resolvedConfig.airtableConfigured;
  state.revolutBusinessTransfers.configured = Boolean(
    resolvedConfig.airtableConfigured && hasResolvedSourceAccountId && databaseConfig.configured,
  );
  state.revolutBusinessTransfers.configurationError = configurationError || null;
  state.revolutBusinessTransfers.discoveredAccountsCount =
    revolutBusinessSourceAccountDiscoveryRuntime.accounts.length;
  state.revolutBusinessTransfers.discoveredAccountsPreview =
    revolutBusinessSourceAccountDiscoveryRuntime.accounts.slice(0, 10).map((account) => ({
      id: account.id,
      name: account.name,
      currency: account.currency,
      state: account.state,
      type: account.type,
      public: account.public,
    }));
  state.revolutBusinessTransfers.lastDiscoveryAt =
    revolutBusinessSourceAccountDiscoveryRuntime.successfulAt;
  state.revolutBusinessTransfers.lastDiscoveryAttemptAt =
    revolutBusinessSourceAccountDiscoveryRuntime.lastAttemptAt;
  state.revolutBusinessTransfers.lastDiscoveryError =
    revolutBusinessSourceAccountDiscoveryRuntime.lastError;
  state.revolutBusinessTransfers.lastDiscoveryRequestUrl =
    revolutBusinessSourceAccountDiscoveryRuntime.lastRequestUrl;
  state.revolutBusinessTransfers.lastDiscoveryStatus =
    revolutBusinessSourceAccountDiscoveryRuntime.lastStatus;
  state.revolutBusinessTransfers.lastDiscoveryTrigger =
    revolutBusinessSourceAccountDiscoveryRuntime.lastTrigger;
  state.revolutBusinessTransfers.revolutBusinessConfigured = revolutConfig.configured;
  state.revolutBusinessTransfers.revolutMerchantFallbackConfigured =
    revolutMerchantConfig.configured;
  state.revolutBusinessTransfers.sourceAccountId = resolvedConfig.sourceAccountId;
  state.revolutBusinessTransfers.sourceAccountIdPresent = hasResolvedSourceAccountId;
  state.revolutBusinessTransfers.sourceAccountIdSource =
    getResolvedRevolutBusinessTransferSourceAccountSource() || null;
  state.revolutBusinessTransfers.sourceAccountSelectionReason =
    getResolvedRevolutBusinessTransferSourceAccountReason() || null;

  if (configurationError) {
    if (
      !state.revolutBusinessTransfers.lastError ||
      isRevolutBusinessSourceAccountConfigurationError(state.revolutBusinessTransfers.lastError)
    ) {
      state.revolutBusinessTransfers.lastError = configurationError;
    }
  } else if (
    isRevolutBusinessSourceAccountConfigurationError(state.revolutBusinessTransfers.lastError)
  ) {
    state.revolutBusinessTransfers.lastError = null;
  }

  return resolvedConfig;
}

function createRevolutBusinessTransferExecutionConfig() {
  const enabled = parseConfiguredBoolean(
    readNonEmptyEnv([
      "REVOLUT_TRANSFER_EXECUTION_ENABLED",
      "HARVESTER_REVOLUT_TRANSFER_EXECUTION_ENABLED",
    ]),
    false,
  ).value;
  const batchSize = Math.min(
    Math.max(
      Number.parseInt(
        readNonEmptyEnv([
          "REVOLUT_TRANSFER_EXECUTION_BATCH_SIZE",
          "HARVESTER_REVOLUT_TRANSFER_EXECUTION_BATCH_SIZE",
        ]) || `${DEFAULT_REVOLUT_TRANSFER_EXECUTION_BATCH_SIZE}`,
        10,
      ) || DEFAULT_REVOLUT_TRANSFER_EXECUTION_BATCH_SIZE,
      1,
    ),
    100,
  );

  return {
    batchSize,
    enabled,
    optInField: "confirmExecution",
  };
}

const revolutBusinessTransferExecutionConfig = createRevolutBusinessTransferExecutionConfig();

function createDatabaseSslConfig(sslMode) {
  const normalizedSslMode = sslMode.toLowerCase();

  if (normalizedSslMode === "disable") {
    return {
      ssl: false,
      sslRejectUnauthorized: false,
      sslRootCertConfigured: false,
      sslMode: normalizedSslMode,
      tlsVerification: "disabled",
    };
  }

  const rejectUnauthorized = parseConfiguredBoolean(
    readNonEmptyEnv([
      "DATABASE_SSL_REJECT_UNAUTHORIZED",
      "PGSSLREJECTUNAUTHORIZED",
      "DATABASE_SSL_VERIFY",
    ]),
    true,
  ).value;
  const inlineRootCert = readOptionalPem(["DATABASE_SSL_ROOT_CERT", "PGSSLROOTCERT_CONTENT"]);
  const rootCertPath = readNonEmptyEnv(["DATABASE_SSL_ROOT_CERT_PATH", "PGSSLROOTCERT"]);
  const rootCert = inlineRootCert || (rootCertPath ? readFileSync(rootCertPath, "utf8") : "");
  const ssl = {
    rejectUnauthorized,
  };

  if (rootCert) {
    ssl.ca = rootCert;
  }

  return {
    ssl,
    sslRejectUnauthorized: rejectUnauthorized,
    sslRootCertConfigured: Boolean(rootCert),
    sslMode: normalizedSslMode,
    tlsVerification: rejectUnauthorized ? "verified" : "encrypted-no-verify",
  };
}

function createDatabaseConfig() {
  const host = readNonEmptyEnv(["DATABASE_HOST", "POSTGRES_HOST"]);
  const portValue = readNonEmptyEnv(["DATABASE_PORT", "POSTGRES_PORT"]) || "5432";
  const database = readNonEmptyEnv(["DATABASE_NAME", "POSTGRES_DB"]);
  const user = readNonEmptyEnv(["DATABASE_USER", "POSTGRES_USER"]);
  const password = readNonEmptyEnv(["DATABASE_PASSWORD", "POSTGRES_PASSWORD"]);
  const sslMode = readNonEmptyEnv(["DATABASE_SSLMODE", "PGSSLMODE", "DATABASE_SSL"]) || "require";
  const databaseSsl = createDatabaseSslConfig(sslMode);
  const port = Number.parseInt(portValue, 10);
  const configured = Boolean(host && Number.isFinite(port) && database && user && password);

  return {
    configured,
    host,
    port: Number.isFinite(port) ? port : 5432,
    database,
    user,
    password,
    ssl: databaseSsl.ssl,
    sslMode: databaseSsl.sslMode,
    sslRejectUnauthorized: databaseSsl.sslRejectUnauthorized,
    sslRootCertConfigured: databaseSsl.sslRootCertConfigured,
    tlsVerification: databaseSsl.tlsVerification,
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
const PAYPAL_WEBHOOK_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS alphabet_paypal_webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    resource_id TEXT,
    resource_type TEXT,
    resource_status TEXT,
    amount_value NUMERIC(18, 4),
    currency TEXT,
    amount_display TEXT,
    webhook_id TEXT,
    transmission_id TEXT,
    transmission_time TIMESTAMPTZ,
    transmission_sig TEXT,
    auth_algo TEXT,
    cert_url TEXT,
    public_url TEXT,
    webhook_url TEXT,
    verification_status TEXT NOT NULL,
    created_at TIMESTAMPTZ,
    raw_payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;
const PAYPAL_WEBHOOK_EVENTS_RECEIVED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_paypal_webhook_events_received_at_idx
  ON alphabet_paypal_webhook_events (received_at DESC)
`;
const PAYPAL_WEBHOOK_EVENTS_TYPE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_paypal_webhook_events_type_idx
  ON alphabet_paypal_webhook_events (event_type, received_at DESC)
`;
const REVOLUT_MERCHANT_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS alphabet_revolut_merchant_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL,
    order_id TEXT,
    payment_id TEXT,
    merchant_order_reference TEXT,
    merchant_reference TEXT,
    payment_status TEXT,
    settlement_status TEXT,
    amount_minor BIGINT,
    amount_value NUMERIC(18, 4),
    currency TEXT,
    settlement_amount_minor BIGINT,
    settlement_amount_value NUMERIC(18, 4),
    settlement_currency TEXT,
    customer_email TEXT,
    amount_display TEXT,
    settlement_amount_display TEXT,
    created_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    webhook_id TEXT,
    request_id TEXT,
    public_url TEXT,
    webhook_url TEXT,
    target_assets_eur BIGINT NOT NULL,
    raw_payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;
const REVOLUT_MERCHANT_ORDERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS alphabet_revolut_merchant_orders (
    order_id TEXT PRIMARY KEY,
    order_state TEXT NOT NULL,
    payment_status TEXT,
    payment_id TEXT,
    merchant_order_reference TEXT,
    merchant_reference TEXT,
    checkout_url TEXT,
    amount_minor BIGINT,
    amount_value NUMERIC(18, 4),
    currency TEXT,
    customer_email TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_payload JSONB NOT NULL
  )
`;
const REVOLUT_MERCHANT_ORDERS_UPDATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_revolut_merchant_orders_updated_at_idx
  ON alphabet_revolut_merchant_orders (updated_at DESC NULLS LAST)
`;
const REVOLUT_MERCHANT_ORDERS_STATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_revolut_merchant_orders_state_idx
  ON alphabet_revolut_merchant_orders (order_state, updated_at DESC NULLS LAST)
`;
const REVOLUT_MERCHANT_EVENTS_RECEIVED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_revolut_merchant_events_received_at_idx
  ON alphabet_revolut_merchant_events (received_at DESC)
`;
const REVOLUT_MERCHANT_EVENTS_TYPE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_revolut_merchant_events_type_idx
  ON alphabet_revolut_merchant_events (event_type, received_at DESC)
`;
const REVOLUT_MERCHANT_EVENTS_ORDER_ID_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_revolut_merchant_events_order_id_idx
  ON alphabet_revolut_merchant_events (order_id)
`;
const REVOLUT_MERCHANT_EVENTS_MERCHANT_ORDER_REF_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_revolut_merchant_events_merchant_order_ref_idx
  ON alphabet_revolut_merchant_events (merchant_order_reference)
`;
const REVOLUT_MERCHANT_EVENTS_ALTER_SQL = [
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS order_id TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS payment_id TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS merchant_order_reference TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS merchant_reference TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS payment_status TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS settlement_status TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS amount_minor BIGINT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS amount_value NUMERIC(18, 4)",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS currency TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS settlement_amount_minor BIGINT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS settlement_amount_value NUMERIC(18, 4)",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS settlement_currency TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS customer_email TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS amount_display TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS settlement_amount_display TEXT",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ",
  "ALTER TABLE alphabet_revolut_merchant_events ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ",
];
const REVOLUT_MERCHANT_ORDERS_ALTER_SQL = [
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS payment_status TEXT",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS payment_id TEXT",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS merchant_order_reference TEXT",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS merchant_reference TEXT",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS checkout_url TEXT",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS amount_minor BIGINT",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS amount_value NUMERIC(18, 4)",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS currency TEXT",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS customer_email TEXT",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
  "ALTER TABLE alphabet_revolut_merchant_orders ADD COLUMN IF NOT EXISTS raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb",
];
const REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS alphabet_revolut_business_transfer_queue (
    source_record_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    queue_status TEXT NOT NULL DEFAULT 'prepared',
    recipient_name TEXT,
    amount NUMERIC(18, 4),
    amount_display TEXT,
    currency TEXT NOT NULL,
    reference TEXT NOT NULL,
    source_account_id TEXT,
    counterparty_id TEXT,
    receiver_account_id TEXT,
    receiver_card_id TEXT,
    charge_bearer TEXT NOT NULL,
    transfer_reason_code TEXT,
    opt_in_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    transfer_id TEXT,
    transfer_state TEXT,
    source_created_time TIMESTAMPTZ,
    prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    request_body JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_result JSONB,
    last_error TEXT
  )
`;
const REVOLUT_BUSINESS_TRANSFER_QUEUE_UPDATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_revolut_business_transfer_queue_updated_at_idx
  ON alphabet_revolut_business_transfer_queue (updated_at DESC)
`;
const REVOLUT_BUSINESS_TRANSFER_QUEUE_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_revolut_business_transfer_queue_status_idx
  ON alphabet_revolut_business_transfer_queue (queue_status, queued_at ASC)
`;
const REVOLUT_BUSINESS_TRANSFER_QUEUE_EXECUTED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS alphabet_revolut_business_transfer_queue_executed_at_idx
  ON alphabet_revolut_business_transfer_queue (executed_at DESC NULLS LAST)
`;
const REVOLUT_BUSINESS_TRANSFER_QUEUE_ALTER_SQL = [
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS request_id TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS queue_status TEXT NOT NULL DEFAULT 'prepared'",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS recipient_name TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS amount NUMERIC(18, 4)",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS amount_display TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS currency TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS reference TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS source_account_id TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS counterparty_id TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS receiver_account_id TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS receiver_card_id TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS charge_bearer TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS transfer_reason_code TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS opt_in_confirmed BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS transfer_id TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS transfer_state TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS source_created_time TIMESTAMPTZ",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS source_payload JSONB NOT NULL DEFAULT '{}'::jsonb",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS request_body JSONB NOT NULL DEFAULT '{}'::jsonb",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS last_result JSONB",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ADD COLUMN IF NOT EXISTS last_error TEXT",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ALTER COLUMN source_account_id DROP NOT NULL",
  "ALTER TABLE alphabet_revolut_business_transfer_queue ALTER COLUMN counterparty_id DROP NOT NULL",
];

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

function readNestedValue(value, path) {
  let current = value;

  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return null;
    }

    current = current[segment];
  }

  return current ?? null;
}

function pickFirstNestedValue(value, paths) {
  for (const path of paths) {
    const candidate = readNestedValue(value, path);

    if (candidate !== null && candidate !== undefined && candidate !== "") {
      return candidate;
    }
  }

  return null;
}

function normalizeTextValue(value) {
  if (typeof value === "string") {
    const trimmedValue = value.trim();
    return trimmedValue || null;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return null;
}

function normalizeNumericValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "object") {
    return (
      normalizeNumericValue(value.value) ??
      normalizeNumericValue(value.amount) ??
      normalizeNumericValue(value.minor_units) ??
      normalizeNumericValue(value.minorUnits) ??
      null
    );
  }

  const parsedValue = Number.parseFloat(String(value).replace(/,/gu, ""));
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function normalizeIntegerValue(value) {
  const numericValue = normalizeNumericValue(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : null;
}

function normalizeTimestampValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return null;
    }

    const parsedValue = Date.parse(trimmedValue);
    return Number.isFinite(parsedValue) ? new Date(parsedValue).toISOString() : null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }

    if (value > 1_000_000_000_000) {
      return new Date(value).toISOString();
    }

    if (value > 1_000_000_000) {
      return new Date(value * 1000).toISOString();
    }
  }

  return null;
}

function formatCurrencyDisplay(amountValue, currency) {
  if (!Number.isFinite(amountValue)) {
    return null;
  }

  const resolvedCurrency = normalizeTextValue(currency)?.toUpperCase() || "EUR";

  try {
    return new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency: resolvedCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amountValue);
  } catch {
    return `${amountValue.toLocaleString("en-IE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ${resolvedCurrency}`;
  }
}

function formatNumberDisplay(value, { minimumFractionDigits = 0, maximumFractionDigits = 4 } = {}) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return new Intl.NumberFormat("en-IE", {
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(value);
}

function buildEmpireCountdownLabel(targetIso, referenceTimeMs = Date.now()) {
  const targetTimeMs = Date.parse(targetIso);

  if (!Number.isFinite(targetTimeMs)) {
    return "--";
  }

  const remainingMs = targetTimeMs - referenceTimeMs;

  if (remainingMs <= 0) {
    return "MATURED";
  }

  const totalHours = Math.floor(remainingMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  return `${days}d ${hours}h`;
}

function calculatePaypalRecoverySnapshot(referenceTimeMs = Date.now()) {
  const targetTimeMs = Date.parse(empireConfig.paypalRecoveryTargetDate);

  if (!Number.isFinite(targetTimeMs)) {
    return {
      accruedInterestDisplay: formatCurrencyDisplay(0, "EUR"),
      accruedInterestEur: 0,
      apr: empireConfig.paypalRecoveryApr,
      countdownLabel: "--",
      daysRemaining: null,
      principalDisplay: formatCurrencyDisplay(empireConfig.paypalRecoveryPrincipalEur, "EUR"),
      principalEur: empireConfig.paypalRecoveryPrincipalEur,
      targetDate: empireConfig.paypalRecoveryTargetDate,
      targetValueDisplay: formatCurrencyDisplay(empireConfig.paypalRecoveryPrincipalEur, "EUR"),
      targetValueEur: empireConfig.paypalRecoveryPrincipalEur,
    };
  }

  const remainingMs = Math.max(targetTimeMs - referenceTimeMs, 0);
  const accruedInterestEur =
    empireConfig.paypalRecoveryPrincipalEur *
    empireConfig.paypalRecoveryApr *
    (remainingMs / (1000 * 60 * 60 * 24) / 365);
  const targetValueEur = empireConfig.paypalRecoveryPrincipalEur + accruedInterestEur;

  return {
    accruedInterestDisplay: formatCurrencyDisplay(accruedInterestEur, "EUR"),
    accruedInterestEur,
    apr: empireConfig.paypalRecoveryApr,
    countdownLabel: buildEmpireCountdownLabel(
      empireConfig.paypalRecoveryTargetDate,
      referenceTimeMs,
    ),
    daysRemaining: remainingMs / (1000 * 60 * 60 * 24),
    principalDisplay: formatCurrencyDisplay(empireConfig.paypalRecoveryPrincipalEur, "EUR"),
    principalEur: empireConfig.paypalRecoveryPrincipalEur,
    targetDate: empireConfig.paypalRecoveryTargetDate,
    targetValueDisplay: formatCurrencyDisplay(targetValueEur, "EUR"),
    targetValueEur,
  };
}

async function fetchEmpireMarketSnapshot({ forceRefresh = false } = {}) {
  const nowMs = Date.now();
  const cacheAgeMs = nowMs - empireMarketCache.fetchedAtMs;
  const cacheIsWarm =
    empireMarketCache.payload && cacheAgeMs >= 0 && cacheAgeMs < empireConfig.marketCacheTtlMs;

  if (!forceRefresh && cacheIsWarm) {
    return {
      ...empireMarketCache.payload,
      cacheAgeMs,
      stale: false,
    };
  }

  try {
    const requestUrl = new URL(`./simple/price`, `${empireConfig.marketApiBaseUrl}/`);
    requestUrl.searchParams.set("ids", empireConfig.assets.map((asset) => asset.id).join(","));
    requestUrl.searchParams.set("vs_currencies", "eur");

    const response = await fetch(requestUrl, {
      headers: {
        Accept: "application/json",
        [BLUEPRINT_SYNC_HEADER_NAME]: BLUEPRINT_SYNC_REF,
        [SOVEREIGN_STATUS_HEADER_NAME]: SOVEREIGN_STATUS_HEADER_VALUE,
        "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
      },
    });
    const payload = await parseResponsePayload(response);

    if (!response.ok) {
      const detail =
        payload && typeof payload === "object" ? JSON.stringify(payload) : String(payload);

      throw new Error(`Empire market ${response.status}: ${detail}`);
    }

    const fetchedAt = new Date().toISOString();
    const assets = empireConfig.assets.map((asset) => {
      const priceEur = Number(payload?.[asset.id]?.eur);
      const normalizedPriceEur = Number.isFinite(priceEur) ? priceEur : null;
      const valueEur = Number.isFinite(normalizedPriceEur)
        ? normalizedPriceEur * asset.holdings
        : null;
      const holdingsIsWholeNumber = Number.isInteger(asset.holdings);

      return {
        id: asset.id,
        label: asset.label,
        holdings: asset.holdings,
        holdingsConfigured: asset.holdingsConfigured,
        holdingsDisplay: formatNumberDisplay(asset.holdings, {
          minimumFractionDigits: holdingsIsWholeNumber ? 0 : 2,
          maximumFractionDigits: holdingsIsWholeNumber ? 0 : 6,
        }),
        priceDisplay:
          normalizedPriceEur === null ? null : formatCurrencyDisplay(normalizedPriceEur, "EUR"),
        priceEur: normalizedPriceEur,
        source: EMPIRE_MARKET_SOURCE,
        symbol: asset.symbol,
        valueDisplay: valueEur === null ? null : formatCurrencyDisplay(valueEur, "EUR"),
        valueEur,
      };
    });
    const totalValueEur = assets.reduce(
      (sum, asset) => sum + (Number.isFinite(asset.valueEur) ? asset.valueEur : 0),
      0,
    );
    const snapshot = {
      assets,
      fetchedAt,
      source: EMPIRE_MARKET_SOURCE,
      summary: {
        configuredAssetCount: assets.filter((asset) => asset.holdingsConfigured).length,
        totalValueDisplay: formatCurrencyDisplay(totalValueEur, "EUR"),
        totalValueEur,
      },
    };

    empireMarketCache.fetchedAtMs = nowMs;
    empireMarketCache.payload = snapshot;
    state.empire.lastError = null;
    state.empire.lastUpdated = fetchedAt;

    return {
      ...snapshot,
      cacheAgeMs: 0,
      stale: false,
    };
  } catch (error) {
    state.empire.lastError = error.message;
    state.empire.lastUpdated = new Date().toISOString();

    if (empireMarketCache.payload) {
      log("warning", `💹 Empire market refresh failed, serving cached quotes: ${error.message}`);

      return {
        ...empireMarketCache.payload,
        cacheAgeMs: Date.now() - empireMarketCache.fetchedAtMs,
        fallbackError: error.message,
        stale: true,
      };
    }

    throw error;
  }
}

function normalizeMoneyValue(value, fallbackCurrency = null) {
  const amountValue = normalizeNumericValue(value);
  const amountMinorFromValue =
    Number.isFinite(amountValue) && Number.isInteger(amountValue) ? Math.trunc(amountValue) : null;
  const amountMinor =
    value && typeof value === "object"
      ? (normalizeIntegerValue(
          value.minor_units ?? value.minorUnits ?? value.value_minor ?? value.valueMinor,
        ) ?? amountMinorFromValue)
      : amountMinorFromValue;
  const currency = normalizeTextValue(
    (value && typeof value === "object" ? (value.currency ?? value.ccy) : null) ?? fallbackCurrency,
  );

  return {
    amountMinor,
    amountValue,
    currency,
  };
}

function mapRevolutMerchantEventRow(row) {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    source: row.source,
    orderId: row.order_id,
    paymentId: row.payment_id,
    merchantOrderReference: row.merchant_order_reference,
    merchantReference: row.merchant_reference,
    paymentStatus: row.payment_status,
    settlementStatus: row.settlement_status,
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
    amountValue: row.amount_value === null ? null : Number(row.amount_value),
    currency: row.currency,
    settlementAmountMinor:
      row.settlement_amount_minor === null ? null : Number(row.settlement_amount_minor),
    settlementAmountValue:
      row.settlement_amount_value === null ? null : Number(row.settlement_amount_value),
    settlementCurrency: row.settlement_currency,
    customerEmail: row.customer_email,
    amountDisplay: row.amount_display,
    settlementAmountDisplay: row.settlement_amount_display,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    webhookId: row.webhook_id,
    requestId: row.request_id,
    publicUrl: row.public_url,
    webhookUrl: row.webhook_url,
    targetAssetsEur: row.target_assets_eur === null ? null : Number(row.target_assets_eur),
    receivedAt: row.received_at,
  };
}

function mapRevolutMerchantOrderRow(row) {
  const amountValue = row.amount_value === null ? null : Number(row.amount_value);
  const currency = row.currency || null;

  return {
    orderId: row.order_id,
    orderState: row.order_state,
    paymentStatus: row.payment_status,
    paymentId: row.payment_id,
    merchantOrderReference: row.merchant_order_reference,
    merchantReference: row.merchant_reference,
    checkoutUrl: row.checkout_url,
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
    amountValue,
    amountDisplay: formatCurrencyDisplay(amountValue, currency),
    currency,
    customerEmail: row.customer_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at,
  };
}

function clampRevolutMerchantEventsLimit(value) {
  const parsedValue = Number.parseInt(String(value ?? "10"), 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 10;
  }

  return Math.min(parsedValue, 50);
}

function clampRevolutMerchantOrdersLimit(value) {
  const parsedValue = Number.parseInt(String(value ?? "8"), 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 8;
  }

  return Math.min(parsedValue, 50);
}

function extractRevolutCustomerEmail(payload) {
  return normalizeTextValue(
    pickFirstNestedValue(payload, [
      ["customer", "email"],
      ["order", "customer", "email"],
      ["payment", "customer", "email"],
      ["payment", "billing_details", "email"],
      ["billing_details", "email"],
      ["data", "customer", "email"],
      ["customer_email"],
      ["email"],
    ]),
  );
}

function extractPayPalWebhookAmount(payload) {
  const amountValue = normalizeNumericValue(
    pickFirstNestedValue(payload, [
      ["resource", "amount", "value"],
      ["resource", "seller_receivable_breakdown", "gross_amount", "value"],
      ["resource", "amount_with_breakdown", "gross_amount", "value"],
      ["resource", "gross_amount", "value"],
    ]),
  );
  const currency =
    normalizeTextValue(
      pickFirstNestedValue(payload, [
        ["resource", "amount", "currency_code"],
        ["resource", "amount", "currency"],
        ["resource", "seller_receivable_breakdown", "gross_amount", "currency_code"],
        ["resource", "amount_with_breakdown", "gross_amount", "currency_code"],
        ["resource", "gross_amount", "currency_code"],
      ]),
    )?.toUpperCase() || null;

  return {
    amountDisplay:
      amountValue !== null && currency ? formatCurrencyDisplay(amountValue, currency) : null,
    amountValue,
    currency,
  };
}

function summarizePayPalSandboxWebhook(req, verificationStatus) {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const { amountDisplay, amountValue, currency } = extractPayPalWebhookAmount(payload);

  return {
    amountDisplay,
    amountValue,
    authAlgo: normalizeTextValue(req.get("paypal-auth-algo")),
    certUrl: normalizeTextValue(req.get("paypal-cert-url")),
    createdAt: normalizeTimestampValue(payload?.create_time),
    currency,
    eventId:
      normalizeTextValue(payload?.id) ||
      normalizeTextValue(req.get("paypal-transmission-id")) ||
      randomUUID(),
    eventType: normalizeTextValue(payload?.event_type) || "UNKNOWN",
    publicUrl: getHarvesterPublicUrl(req),
    resourceId:
      normalizeTextValue(
        pickFirstNestedValue(payload, [
          ["resource", "id"],
          ["resource", "supplementary_data", "related_ids", "capture_id"],
          ["resource", "supplementary_data", "related_ids", "order_id"],
          ["resource", "supplementary_data", "related_ids", "authorization_id"],
          ["resource", "invoice_id"],
        ]),
      ) || null,
    resourceStatus:
      normalizeTextValue(
        pickFirstNestedValue(payload, [
          ["resource", "status"],
          ["resource", "state"],
        ]),
      ) || null,
    resourceType:
      normalizeTextValue(payload?.resource_type) ||
      normalizeTextValue(readNestedValue(payload, ["resource", "resource_type"])) ||
      null,
    transmissionId: normalizeTextValue(req.get("paypal-transmission-id")),
    transmissionSig: normalizeTextValue(req.get("paypal-transmission-sig")),
    transmissionTime: normalizeTimestampValue(req.get("paypal-transmission-time")),
    verificationStatus,
    webhookId: paypalSandboxConfig.webhookId,
    webhookUrl: getPayPalSandboxWebhookUrl(req),
  };
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
    throw new Error(`Stripe secret resolution failed: ${error.message}`, { cause: error });
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

  if (!sanitizedPath) {
    throw new Error(
      "Stripe API path is empty; expected a resource such as 'balance', 'charges', or 'account'",
    );
  }

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

async function resolvePayPalSandboxAccessToken({ forceRefresh = false } = {}) {
  if (!paypalSandboxConfig.credentialsConfigured) {
    throw new Error("PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET must be configured");
  }

  const cacheIsWarm =
    paypalSandboxAccessTokenCache.accessToken &&
    paypalSandboxAccessTokenCache.expiresAtMs - Date.now() > 30 * 1000;

  if (!forceRefresh && cacheIsWarm) {
    state.paypal.accessTokenPresent = true;
    return paypalSandboxAccessTokenCache.accessToken;
  }

  const requestUrl = new URL("v1/oauth2/token", `${paypalSandboxConfig.apiBaseUrl}/`);
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${paypalSandboxConfig.clientId}:${paypalSandboxConfig.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });
  const payload = await parseResponsePayload(response);

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? payload.error_description || payload.error || JSON.stringify(payload)
        : String(payload);

    state.paypal.accessTokenPresent = false;
    state.paypal.lastAuthStatus = response.status;
    state.paypal.lastError = `PayPal Sandbox OAuth ${response.status}: ${detail}`;
    state.paypal.lastUpdated = new Date().toISOString();
    throw new Error(state.paypal.lastError);
  }

  const accessToken = normalizeTextValue(payload?.access_token);
  const expiresInSeconds = Number.parseInt(String(payload?.expires_in ?? "0"), 10);

  if (!accessToken) {
    throw new Error("PayPal Sandbox OAuth response did not include access_token");
  }

  const now = Date.now();
  const expiresAtMs =
    Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? now + expiresInSeconds * 1000
      : now + 5 * 60 * 1000;
  const resolvedAt = new Date(now).toISOString();

  paypalSandboxAccessTokenCache.accessToken = accessToken;
  paypalSandboxAccessTokenCache.expiresAtMs = expiresAtMs;
  paypalSandboxAccessTokenCache.fetchedAtMs = now;

  state.paypal.accessTokenExpiresAt = new Date(expiresAtMs).toISOString();
  state.paypal.accessTokenPresent = true;
  state.paypal.lastAccessTokenAt = resolvedAt;
  state.paypal.lastAuthStatus = response.status;
  state.paypal.lastError = null;
  state.paypal.lastUpdated = resolvedAt;
  return accessToken;
}

async function callPayPalSandboxApi(path, { method = "GET", jsonBody = null } = {}) {
  const accessToken = await resolvePayPalSandboxAccessToken();
  const requestUrl = new URL(path.replace(/^\/+|\/+$/gu, ""), `${paypalSandboxConfig.apiBaseUrl}/`);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
  };
  const requestOptions = {
    method,
    headers,
  };

  if (jsonBody !== null) {
    headers["Content-Type"] = "application/json";
    requestOptions.body = JSON.stringify(jsonBody);
  }

  const response = await fetch(requestUrl, requestOptions);
  const payload = await parseResponsePayload(response);

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? payload.message || payload.error_description || payload.name || JSON.stringify(payload)
        : String(payload);
    throw new Error(`PayPal Sandbox API ${response.status}: ${detail}`);
  }

  state.paypal.lastError = null;
  state.paypal.lastUpdated = new Date().toISOString();
  return payload;
}

async function verifyPayPalSandboxWebhook(req) {
  if (!paypalSandboxConfig.credentialsConfigured) {
    throw new Error("PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET must be configured");
  }

  if (!paypalSandboxConfig.webhookConfigured) {
    throw new Error("PAYPAL_SANDBOX_WEBHOOK_ID must be configured");
  }

  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new Error("PayPal webhook payload must be a JSON object");
  }

  const verificationPayload = {
    auth_algo: normalizeTextValue(req.get("paypal-auth-algo")),
    cert_url: normalizeTextValue(req.get("paypal-cert-url")),
    transmission_id: normalizeTextValue(req.get("paypal-transmission-id")),
    transmission_sig: normalizeTextValue(req.get("paypal-transmission-sig")),
    transmission_time: normalizeTextValue(req.get("paypal-transmission-time")),
    webhook_event: req.body,
    webhook_id: paypalSandboxConfig.webhookId,
  };
  const missingField = Object.entries(verificationPayload).find(
    ([fieldName, value]) => fieldName !== "webhook_event" && !value,
  );

  if (missingField) {
    throw new Error(`PayPal webhook verification field missing: ${missingField[0]}`);
  }

  const verificationResponse = await callPayPalSandboxApi(
    "/v1/notifications/verify-webhook-signature",
    {
      jsonBody: verificationPayload,
      method: "POST",
    },
  );
  const verificationStatus =
    normalizeTextValue(verificationResponse?.verification_status)?.toUpperCase() || "UNKNOWN";
  const verifiedAt = new Date().toISOString();

  state.paypal.lastTransmissionId = verificationPayload.transmission_id;
  state.paypal.lastWebhookVerificationStatus = verificationStatus;
  state.paypal.lastWebhookVerificationError =
    verificationStatus === "SUCCESS"
      ? null
      : `PayPal webhook signature verification returned ${verificationStatus}`;
  state.paypal.lastUpdated = verifiedAt;

  if (verificationStatus !== "SUCCESS") {
    throw new Error(`PayPal webhook signature verification returned ${verificationStatus}`);
  }

  return { verificationStatus };
}

async function parseResponsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? await response.json() : await response.text();
}

const AIRTABLE_TRANSFER_FIELD_ALIASES = Object.freeze({
  amount: [
    "Amount",
    "amount",
    "Transfer Amount",
    "Payout Amount",
    "Amount EUR",
    "Upphæð",
    "Upphæð EUR",
  ],
  currency: ["Currency", "currency", "Currency Code", "Gjaldmiðill"],
  sourceAccountId: ["Source Account ID", "source_account_id", "Revolut Source Account ID"],
  counterpartyId: [
    "Counterparty ID",
    "counterparty_id",
    "Revolut Counterparty ID",
    "Receiver Counterparty ID",
  ],
  receiverAccountId: [
    "Receiver Account ID",
    "receiver_account_id",
    "Beneficiary Account ID",
    "Revolut Receiver Account ID",
  ],
  receiverCardId: [
    "Receiver Card ID",
    "receiver_card_id",
    "Beneficiary Card ID",
    "Revolut Receiver Card ID",
  ],
  reference: ["Reference", "reference", "Description", "description", "Skýring", "Lýsing"],
  recipientName: [
    "Recipient",
    "recipient",
    "Counterparty Name",
    "Business Name",
    "Name",
    "Nafn",
    "Viðtakandi",
  ],
  transferReasonCode: [
    "Transfer Reason Code",
    "transfer_reason_code",
    "Reason Code",
    "Transfer Reason",
  ],
  chargeBearer: ["Charge Bearer", "charge_bearer"],
});

function clampAirtableTransferMaxRecords(value) {
  const parsedValue = Number.parseInt(String(value ?? airtableTransferConfig.maxRecords), 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return airtableTransferConfig.maxRecords;
  }

  return Math.min(parsedValue, 500);
}

function normalizeChargeBearer(value) {
  const normalizedValue = normalizeTextValue(value)?.toLowerCase();
  return ["shared", "sender", "receiver"].includes(normalizedValue) ? normalizedValue : null;
}

function unwrapAirtableFieldValue(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolvedEntry = unwrapAirtableFieldValue(entry);

      if (resolvedEntry !== null && resolvedEntry !== undefined && resolvedEntry !== "") {
        return resolvedEntry;
      }
    }

    return null;
  }

  if (value && typeof value === "object") {
    return (
      value.name ?? value.label ?? value.text ?? value.value ?? value.id ?? value.amount ?? null
    );
  }

  return value ?? null;
}

function buildAirtableFieldIndex(fields) {
  const fieldIndex = new Map();

  if (!fields || typeof fields !== "object") {
    return fieldIndex;
  }

  for (const [key, value] of Object.entries(fields)) {
    fieldIndex.set(key.trim().toLowerCase(), value);
  }

  return fieldIndex;
}

function readAirtableFieldValue(fieldIndex, candidates) {
  for (const candidate of candidates) {
    const rawValue = fieldIndex.get(candidate.trim().toLowerCase());

    if (rawValue === undefined) {
      continue;
    }

    const resolvedValue = unwrapAirtableFieldValue(rawValue);

    if (resolvedValue !== null && resolvedValue !== undefined && resolvedValue !== "") {
      return resolvedValue;
    }
  }

  return null;
}

function normalizeTransferAmountValue(value) {
  if (typeof value === "string") {
    return normalizeNumericValue(value.replace(/[^0-9,.-]/gu, ""));
  }

  return normalizeNumericValue(value);
}

function buildRevolutTransferRequestId(recordId) {
  const sanitizedId = String(recordId || randomUUID())
    .replace(/[^A-Za-z0-9_-]/gu, "")
    .slice(0, 60);

  return `airtable-${sanitizedId || randomUUID().replace(/-/gu, "")}`;
}

function normalizeAirtableTransferDraft(record, defaults = {}) {
  const fields = record?.fields && typeof record.fields === "object" ? record.fields : {};
  const fieldIndex = buildAirtableFieldIndex(fields);
  const sourceRecordId = normalizeTextValue(record?.id) || null;
  const requestId = buildRevolutTransferRequestId(sourceRecordId);
  const amount = normalizeTransferAmountValue(
    readAirtableFieldValue(fieldIndex, AIRTABLE_TRANSFER_FIELD_ALIASES.amount),
  );
  const currency = (
    normalizeTextValue(
      readAirtableFieldValue(fieldIndex, AIRTABLE_TRANSFER_FIELD_ALIASES.currency),
    ) ||
    defaults.defaultCurrency ||
    "EUR"
  ).toUpperCase();
  const sourceAccountId =
    normalizeTextValue(
      readAirtableFieldValue(fieldIndex, AIRTABLE_TRANSFER_FIELD_ALIASES.sourceAccountId),
    ) ||
    defaults.sourceAccountId ||
    null;
  const counterpartyId =
    normalizeTextValue(
      readAirtableFieldValue(fieldIndex, AIRTABLE_TRANSFER_FIELD_ALIASES.counterpartyId),
    ) ||
    defaults.defaultCounterpartyId ||
    null;
  const receiverAccountId =
    normalizeTextValue(
      readAirtableFieldValue(fieldIndex, AIRTABLE_TRANSFER_FIELD_ALIASES.receiverAccountId),
    ) ||
    defaults.defaultReceiverAccountId ||
    null;
  const receiverCardId =
    normalizeTextValue(
      readAirtableFieldValue(fieldIndex, AIRTABLE_TRANSFER_FIELD_ALIASES.receiverCardId),
    ) ||
    defaults.defaultReceiverCardId ||
    null;
  const recipientName = normalizeTextValue(
    readAirtableFieldValue(fieldIndex, AIRTABLE_TRANSFER_FIELD_ALIASES.recipientName),
  );
  const transferReasonCode =
    normalizeTextValue(
      readAirtableFieldValue(fieldIndex, AIRTABLE_TRANSFER_FIELD_ALIASES.transferReasonCode),
    ) ||
    defaults.transferReasonCode ||
    null;
  const chargeBearer =
    normalizeChargeBearer(
      readAirtableFieldValue(fieldIndex, AIRTABLE_TRANSFER_FIELD_ALIASES.chargeBearer),
    ) ||
    normalizeChargeBearer(defaults.chargeBearer) ||
    DEFAULT_REVOLUT_TRANSFER_CHARGE_BEARER;
  const reference =
    normalizeTextValue(
      readAirtableFieldValue(fieldIndex, AIRTABLE_TRANSFER_FIELD_ALIASES.reference),
    ) ||
    `${defaults.defaultReferencePrefix || DEFAULT_REVOLUT_TRANSFER_REFERENCE_PREFIX} ${sourceRecordId || "draft"}`;
  const warnings = [];

  if (!sourceRecordId) {
    warnings.push("Airtable record id is missing.");
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    warnings.push("Amount must resolve to a positive number.");
  }

  if (!/^[A-Z]{3}$/u.test(currency)) {
    warnings.push("Currency must resolve to a 3-letter ISO 4217 code.");
  }

  if (!sourceAccountId) {
    warnings.push("Revolut source account_id is missing.");
  }

  if (!counterpartyId) {
    warnings.push("Revolut receiver.counterparty_id is missing.");
  }

  if (receiverAccountId && receiverCardId) {
    warnings.push("receiver.account_id and receiver.card_id cannot both be set.");
  }

  const receiver = counterpartyId ? { counterparty_id: counterpartyId } : null;

  if (receiver && receiverAccountId) {
    receiver.account_id = receiverAccountId;
  }

  if (receiver && !receiverAccountId && receiverCardId) {
    receiver.card_id = receiverCardId;
  }

  const requestBody = warnings.length
    ? null
    : {
        request_id: requestId,
        account_id: sourceAccountId,
        receiver,
        amount: Number(amount),
        charge_bearer: chargeBearer,
        currency,
        reference,
        ...(transferReasonCode ? { transfer_reason_code: transferReasonCode } : {}),
      };

  return {
    sourceRecordId,
    requestId,
    sourceCreatedTime: normalizeTimestampValue(record?.createdTime),
    recipientName,
    amount,
    amountDisplay: formatCurrencyDisplay(amount, currency),
    currency,
    reference,
    sourceAccountId,
    counterpartyId,
    receiverAccountId,
    receiverCardId,
    chargeBearer,
    transferReasonCode,
    ready: Boolean(requestBody),
    warnings,
    requestBody,
  };
}

async function fetchAirtableTransferRecords({ maxRecords } = {}) {
  if (!airtableTransferConfig.airtableConfigured) {
    throw new Error(
      "Airtable transfer source must be configured via AIRTABLE_* env vars before records can be prepared",
    );
  }

  const resolvedMaxRecords = clampAirtableTransferMaxRecords(maxRecords);
  const records = [];
  let offset = null;

  do {
    const requestUrl = new URL(
      `/v0/${encodeURIComponent(airtableTransferConfig.baseId)}/${encodeURIComponent(
        airtableTransferConfig.tableIdOrName,
      )}`,
      `${airtableTransferConfig.apiBaseUrl}/`,
    );
    const remaining = Math.max(resolvedMaxRecords - records.length, 0);

    requestUrl.searchParams.set("cellFormat", "json");
    requestUrl.searchParams.set(
      "pageSize",
      String(
        Math.min(airtableTransferConfig.pageSize, remaining || airtableTransferConfig.pageSize),
      ),
    );
    requestUrl.searchParams.set("view", airtableTransferConfig.view);

    if (offset) {
      requestUrl.searchParams.set("offset", offset);
    }

    const response = await fetch(requestUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${airtableTransferConfig.apiKey}`,
        [BLUEPRINT_SYNC_HEADER_NAME]: BLUEPRINT_SYNC_REF,
        [SOVEREIGN_STATUS_HEADER_NAME]: SOVEREIGN_STATUS_HEADER_VALUE,
        "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
      },
    });
    const payload = await parseResponsePayload(response);

    if (!response.ok) {
      const detail =
        payload && typeof payload === "object"
          ? payload.error?.message || payload.error?.type || JSON.stringify(payload)
          : String(payload);

      throw new Error(`Airtable list records ${response.status}: ${detail}`);
    }

    if (!payload || typeof payload !== "object" || !Array.isArray(payload.records)) {
      throw new Error("Airtable list records returned an invalid payload");
    }

    records.push(...payload.records);
    offset = typeof payload.offset === "string" ? payload.offset : null;
  } while (offset && records.length < resolvedMaxRecords);

  return records.slice(0, resolvedMaxRecords);
}

function clampRevolutBusinessTransferQueueLimit(value) {
  const parsedValue = Number.parseInt(String(value ?? "25"), 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 25;
  }

  return Math.min(parsedValue, 100);
}

function clampRevolutBusinessTransferExecutionLimit(value) {
  const parsedValue = Number.parseInt(
    String(value ?? revolutBusinessTransferExecutionConfig.batchSize),
    10,
  );

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return revolutBusinessTransferExecutionConfig.batchSize;
  }

  return Math.min(parsedValue, 100);
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((item) => normalizeTextValue(item)).filter(Boolean))];
}

function normalizeRequestedSourceRecordIds(value) {
  if (typeof value === "string") {
    return normalizeTextArray(value.split(","));
  }

  return normalizeTextArray(value);
}

function resolveRevolutBusinessTransferOptIn(value) {
  return parseConfiguredBoolean(value, false).value;
}

function mapRevolutBusinessTransferQueueRow(row) {
  return {
    sourceRecordId: row.source_record_id,
    requestId: row.request_id,
    queueStatus: row.queue_status,
    recipientName: row.recipient_name,
    amount: row.amount === null ? null : Number(row.amount),
    amountDisplay: row.amount_display,
    currency: row.currency,
    reference: row.reference,
    sourceAccountId: row.source_account_id,
    counterpartyId: row.counterparty_id,
    receiverAccountId: row.receiver_account_id,
    receiverCardId: row.receiver_card_id,
    chargeBearer: row.charge_bearer,
    transferReasonCode: row.transfer_reason_code,
    optInConfirmed: Boolean(row.opt_in_confirmed),
    attemptCount: Number(row.attempt_count || 0),
    transferId: row.transfer_id,
    transferState: row.transfer_state,
    sourceCreatedTime: row.source_created_time,
    preparedAt: row.prepared_at,
    queuedAt: row.queued_at,
    executedAt: row.executed_at,
    updatedAt: row.updated_at,
    lastResult: row.last_result ?? null,
    lastError: row.last_error,
    requestBody: row.request_body ?? {},
    sourcePayload: row.source_payload ?? {},
  };
}

async function refreshRevolutBusinessTransferQueueCounts() {
  const emptySummary = {
    blockedCount: 0,
    completedCount: 0,
    failedCount: 0,
    persistedCount: 0,
    preparedCount: 0,
    processingCount: 0,
    table: REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE,
  };

  if (!databasePool) {
    state.revolutBusinessTransfers.persistedCount = emptySummary.persistedCount;
    state.revolutBusinessTransfers.preparedCount = emptySummary.preparedCount;
    state.revolutBusinessTransfers.processingCount = emptySummary.processingCount;
    state.revolutBusinessTransfers.completedCount = emptySummary.completedCount;
    state.revolutBusinessTransfers.failedCount = emptySummary.failedCount;
    state.revolutBusinessTransfers.blockedCount = emptySummary.blockedCount;
    return emptySummary;
  }

  const result = await withDatabaseClient((client) =>
    client.query(`
      SELECT
        COUNT(*)::int AS persisted_count,
        COUNT(*) FILTER (WHERE queue_status = 'prepared')::int AS prepared_count,
        COUNT(*) FILTER (WHERE queue_status = 'processing')::int AS processing_count,
        COUNT(*) FILTER (WHERE queue_status = 'completed')::int AS completed_count,
        COUNT(*) FILTER (WHERE queue_status = 'failed')::int AS failed_count,
        COUNT(*) FILTER (WHERE queue_status = 'blocked')::int AS blocked_count
      FROM ${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE}
    `),
  );
  const row = result.rows[0] || {};
  const summary = {
    blockedCount: Number(row.blocked_count || 0),
    completedCount: Number(row.completed_count || 0),
    failedCount: Number(row.failed_count || 0),
    persistedCount: Number(row.persisted_count || 0),
    preparedCount: Number(row.prepared_count || 0),
    processingCount: Number(row.processing_count || 0),
    table: REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE,
  };

  state.revolutBusinessTransfers.persistedCount = summary.persistedCount;
  state.revolutBusinessTransfers.preparedCount = summary.preparedCount;
  state.revolutBusinessTransfers.processingCount = summary.processingCount;
  state.revolutBusinessTransfers.completedCount = summary.completedCount;
  state.revolutBusinessTransfers.failedCount = summary.failedCount;
  state.revolutBusinessTransfers.blockedCount = summary.blockedCount;
  state.revolutBusinessTransfers.lastUpdated = new Date().toISOString();
  return summary;
}

async function readRevolutBusinessTransferQueue(limit) {
  if (!databasePool) {
    return [];
  }

  const result = await withDatabaseClient((client) =>
    client.query(
      `
        SELECT *
        FROM ${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE}
        ORDER BY updated_at DESC, queued_at DESC
        LIMIT $1
      `,
      [limit],
    ),
  );

  return result.rows.map(mapRevolutBusinessTransferQueueRow);
}

async function readPreparedRevolutBusinessTransferQueueEntries(limit, sourceRecordIds = []) {
  if (!databasePool) {
    return [];
  }

  const normalizedIds = normalizeTextArray(sourceRecordIds);

  if (normalizedIds.length) {
    const result = await withDatabaseClient((client) =>
      client.query(
        `
          SELECT *
          FROM ${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE}
          WHERE queue_status = 'prepared'
            AND source_record_id = ANY($1)
          ORDER BY queued_at ASC, prepared_at ASC
          LIMIT $2
        `,
        [normalizedIds, limit],
      ),
    );

    return result.rows.map(mapRevolutBusinessTransferQueueRow);
  }

  const result = await withDatabaseClient((client) =>
    client.query(
      `
        SELECT *
        FROM ${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE}
        WHERE queue_status = 'prepared'
        ORDER BY queued_at ASC, prepared_at ASC
        LIMIT $1
      `,
      [limit],
    ),
  );

  return result.rows.map(mapRevolutBusinessTransferQueueRow);
}

async function persistPreparedRevolutBusinessTransferQueueEntry(draft, sourceRecord) {
  if (!databasePool) {
    throw new Error(
      "Database must be configured for the persisted Revolut Business transfer queue",
    );
  }

  if (!draft.sourceRecordId) {
    throw new Error("Airtable transfer draft is missing a source record id");
  }

  const queueStatus = draft.ready ? "prepared" : "blocked";
  const lastError = draft.ready ? null : draft.warnings.join(" ");

  return withDatabaseClient(async (client) => {
    const existingResult = await client.query(
      `
        SELECT *
        FROM ${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE}
        WHERE source_record_id = $1
        LIMIT 1
      `,
      [draft.sourceRecordId],
    );
    const existingRow = existingResult.rows[0] || null;

    if (existingRow && ["processing", "completed"].includes(existingRow.queue_status)) {
      return mapRevolutBusinessTransferQueueRow(existingRow);
    }

    const result = await client.query(
      `
        INSERT INTO ${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE} (
          source_record_id,
          request_id,
          queue_status,
          recipient_name,
          amount,
          amount_display,
          currency,
          reference,
          source_account_id,
          counterparty_id,
          receiver_account_id,
          receiver_card_id,
          charge_bearer,
          transfer_reason_code,
          opt_in_confirmed,
          source_created_time,
          prepared_at,
          queued_at,
          updated_at,
          source_payload,
          request_body,
          last_error
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
          FALSE,
          $15,
          NOW(),
          CASE WHEN $3 = 'prepared' THEN NOW() ELSE NOW() END,
          NOW(),
          $16::jsonb,
          $17::jsonb,
          $18
        )
        ON CONFLICT (source_record_id) DO UPDATE SET
          request_id = EXCLUDED.request_id,
          queue_status = EXCLUDED.queue_status,
          recipient_name = EXCLUDED.recipient_name,
          amount = EXCLUDED.amount,
          amount_display = EXCLUDED.amount_display,
          currency = EXCLUDED.currency,
          reference = EXCLUDED.reference,
          source_account_id = EXCLUDED.source_account_id,
          counterparty_id = EXCLUDED.counterparty_id,
          receiver_account_id = EXCLUDED.receiver_account_id,
          receiver_card_id = EXCLUDED.receiver_card_id,
          charge_bearer = EXCLUDED.charge_bearer,
          transfer_reason_code = EXCLUDED.transfer_reason_code,
          opt_in_confirmed = FALSE,
          source_created_time = COALESCE(${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE}.source_created_time, EXCLUDED.source_created_time),
          prepared_at = NOW(),
          queued_at = CASE
            WHEN EXCLUDED.queue_status = 'prepared' THEN NOW()
            ELSE ${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE}.queued_at
          END,
          updated_at = NOW(),
          source_payload = EXCLUDED.source_payload,
          request_body = EXCLUDED.request_body,
          last_result = CASE
            WHEN EXCLUDED.queue_status = 'prepared' THEN NULL
            ELSE ${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE}.last_result
          END,
          last_error = EXCLUDED.last_error
        RETURNING *
      `,
      [
        draft.sourceRecordId,
        draft.requestId,
        queueStatus,
        draft.recipientName,
        draft.amount,
        draft.amountDisplay,
        draft.currency,
        draft.reference,
        draft.sourceAccountId,
        draft.counterpartyId,
        draft.receiverAccountId,
        draft.receiverCardId,
        draft.chargeBearer,
        draft.transferReasonCode,
        draft.sourceCreatedTime,
        stringifyJson(sourceRecord),
        stringifyJson(draft.requestBody || {}),
        lastError,
      ],
    );

    return mapRevolutBusinessTransferQueueRow(result.rows[0]);
  });
}

async function markRevolutBusinessTransferQueueEntryProcessing(sourceRecordId) {
  if (!databasePool) {
    throw new Error(
      "Database must be configured for the persisted Revolut Business transfer queue",
    );
  }

  const result = await withDatabaseClient((client) =>
    client.query(
      `
        UPDATE ${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE}
        SET queue_status = 'processing',
            opt_in_confirmed = TRUE,
            attempt_count = attempt_count + 1,
            updated_at = NOW()
        WHERE source_record_id = $1
          AND queue_status = 'prepared'
        RETURNING *
      `,
      [sourceRecordId],
    ),
  );

  return result.rows[0] ? mapRevolutBusinessTransferQueueRow(result.rows[0]) : null;
}

async function persistRevolutBusinessTransferQueueOutcome(
  sourceRecordId,
  queueStatus,
  payload,
  lastError,
) {
  if (!databasePool) {
    throw new Error(
      "Database must be configured for the persisted Revolut Business transfer queue",
    );
  }

  const transferId = normalizeTextValue(payload?.id) || null;
  const transferState = normalizeTextValue(payload?.state) || null;
  const executedAt =
    normalizeTimestampValue(payload?.created_at ?? payload?.createdAt) ||
    (queueStatus === "completed" ? new Date().toISOString() : null);
  const result = await withDatabaseClient((client) =>
    client.query(
      `
        UPDATE ${REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE}
        SET queue_status = $2,
            transfer_id = COALESCE($3, transfer_id),
            transfer_state = COALESCE($4, transfer_state),
            executed_at = CASE
              WHEN $2 = 'completed' THEN COALESCE($5::timestamptz, NOW())
              ELSE executed_at
            END,
            updated_at = NOW(),
            last_result = $6::jsonb,
            last_error = $7
        WHERE source_record_id = $1
        RETURNING *
      `,
      [
        sourceRecordId,
        queueStatus,
        transferId,
        transferState,
        executedAt,
        stringifyJson(payload),
        lastError,
      ],
    ),
  );

  return result.rows[0] ? mapRevolutBusinessTransferQueueRow(result.rows[0]) : null;
}

async function callRevolutBusinessTransferPay(requestBody, accessToken) {
  const requestUrl = new URL("/api/1.0/pay", `${revolutConfig.revolutBaseUrl}/`);
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      [BLUEPRINT_SYNC_HEADER_NAME]: BLUEPRINT_SYNC_REF,
      [SOVEREIGN_STATUS_HEADER_NAME]: SOVEREIGN_STATUS_HEADER_VALUE,
      "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
    },
    body: JSON.stringify(requestBody),
  });
  const payload = await parseResponsePayload(response);

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? payload.message || payload.error || JSON.stringify(payload)
        : String(payload);

    throw new Error(`Revolut Business /pay ${response.status}: ${detail}`);
  }

  return {
    payload,
    requestUrl: requestUrl.toString(),
  };
}

async function prepareRevolutBusinessTransfersFromAirtable(options = {}) {
  if (!databasePool) {
    throw new Error(
      "Database must be configured for the persisted Revolut Business transfer queue",
    );
  }

  await ensureDatabaseReady("Revolut Business transfer queue");

  if (
    !getResolvedRevolutBusinessTransferSourceAccountId() &&
    getRevolutBusinessSourceAccountDiscoveryMode()
  ) {
    await discoverRevolutBusinessSourceAccount({ reason: "prepare" });
  }

  const preparedAt = new Date().toISOString();
  const resolvedAirtableTransferConfig = getResolvedAirtableTransferConfig();
  const sourceRecords = await fetchAirtableTransferRecords({ maxRecords: options.maxRecords });
  const entries = [];
  const blocked = [];
  const skipped = [];

  for (const record of sourceRecords) {
    const draft = normalizeAirtableTransferDraft(record, resolvedAirtableTransferConfig);

    if (!draft.sourceRecordId) {
      skipped.push({
        recipientName: draft.recipientName,
        warnings: draft.warnings,
      });
      continue;
    }

    const entry = await persistPreparedRevolutBusinessTransferQueueEntry(draft, record);
    entries.push(entry);

    if (entry.queueStatus === "blocked") {
      blocked.push({
        sourceRecordId: entry.sourceRecordId,
        recipientName: entry.recipientName,
        lastError: entry.lastError,
      });
    }
  }

  const queue = await refreshRevolutBusinessTransferQueueCounts();

  state.revolutBusinessTransfers.lastError = null;
  state.revolutBusinessTransfers.lastPreparedAt = preparedAt;
  state.revolutBusinessTransfers.lastPreparedCount = entries.filter(
    (entry) => entry.queueStatus === "prepared",
  ).length;
  state.revolutBusinessTransfers.lastSkippedCount = blocked.length + skipped.length;
  state.revolutBusinessTransfers.lastSourceRecordCount = sourceRecords.length;
  state.revolutBusinessTransfers.lastPreparedPreview = entries.slice(0, 10).map((entry) => ({
    sourceRecordId: entry.sourceRecordId,
    recipientName: entry.recipientName,
    amount: entry.amount,
    amountDisplay: entry.amountDisplay,
    currency: entry.currency,
    reference: entry.reference,
    queueStatus: entry.queueStatus,
    lastError: entry.lastError,
  }));
  state.revolutBusinessTransfers.lastUpdated = preparedAt;

  log(
    "success",
    `🏦 Prepared ${state.revolutBusinessTransfers.lastPreparedCount} Revolut Business transfer queue item(s) from Airtable view ${airtableTransferConfig.view}`,
  );

  return {
    success: true,
    source: REVOLUT_BUSINESS_TRANSFER_PREPARE_SOURCE,
    airtable: {
      apiBaseUrl: resolvedAirtableTransferConfig.apiBaseUrl,
      baseId: resolvedAirtableTransferConfig.baseId,
      tableIdOrName: resolvedAirtableTransferConfig.tableIdOrName,
      view: resolvedAirtableTransferConfig.view,
    },
    execution: {
      businessApiConfigured: revolutConfig.configured,
      endpoint: `${revolutConfig.revolutBaseUrl}/api/1.0/pay`,
      executionEnabled: revolutBusinessTransferExecutionConfig.enabled,
      merchantApiFallbackConfigured: revolutMerchantConfig.configured,
      method: "POST",
      optInField: revolutBusinessTransferExecutionConfig.optInField,
      policy: "explicit-opt-in",
      scopeRequired: "PAY",
    },
    queue,
    summary: {
      blockedCount: blocked.length,
      persistedCount: entries.length,
      preparedAt,
      preparedCount: state.revolutBusinessTransfers.lastPreparedCount,
      skippedCount: skipped.length,
      sourceRecordCount: sourceRecords.length,
    },
    entries,
    blocked,
    skipped,
  };
}

async function executePreparedRevolutBusinessTransfers(options = {}) {
  if (!revolutBusinessTransferExecutionConfig.enabled) {
    throw new Error(
      "Revolut Business transfer execution is disabled; set REVOLUT_TRANSFER_EXECUTION_ENABLED=true to allow /pay execution",
    );
  }

  if (!databasePool) {
    throw new Error(
      "Database must be configured for the persisted Revolut Business transfer queue",
    );
  }

  await ensureDatabaseReady("Revolut Business transfer execution");

  const sourceRecordIds = normalizeTextArray(options.sourceRecordIds);
  const maxItems = clampRevolutBusinessTransferExecutionLimit(options.maxItems);
  const refreshResult = await refreshRevolutAccessToken();
  const accessToken = revolutRuntime.accessToken;

  if (!accessToken) {
    throw new Error("Revolut access token is unavailable after refresh");
  }

  const candidates = await readPreparedRevolutBusinessTransferQueueEntries(
    maxItems,
    sourceRecordIds,
  );
  const results = [];
  let executedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const candidate of candidates) {
    const claimed = await markRevolutBusinessTransferQueueEntryProcessing(candidate.sourceRecordId);

    if (!claimed) {
      skippedCount += 1;
      results.push({
        detail: "Queue entry is no longer in prepared state.",
        queueStatus: candidate.queueStatus,
        sourceRecordId: candidate.sourceRecordId,
      });
      continue;
    }

    try {
      const { payload, requestUrl } = await callRevolutBusinessTransferPay(
        claimed.lastResult?.requestBody || claimed.requestBody || JSON.parse("{}"),
        accessToken,
      );
      const persisted = await persistRevolutBusinessTransferQueueOutcome(
        claimed.sourceRecordId,
        "completed",
        payload,
        null,
      );

      executedCount += 1;
      state.revolutBusinessTransfers.lastTransferId = persisted?.transferId || null;
      state.revolutBusinessTransfers.lastTransferState = persisted?.transferState || null;
      results.push({
        amountDisplay: claimed.amountDisplay,
        currency: claimed.currency,
        queueStatus: persisted?.queueStatus || "completed",
        reference: claimed.reference,
        requestId: claimed.requestId,
        requestUrl,
        sourceRecordId: claimed.sourceRecordId,
        transferId: persisted?.transferId || null,
        transferState: persisted?.transferState || null,
      });
    } catch (error) {
      const persisted = await persistRevolutBusinessTransferQueueOutcome(
        claimed.sourceRecordId,
        "failed",
        {
          error: error.message,
          requestBody: claimed.lastResult?.requestBody || claimed.requestBody || null,
        },
        error.message,
      );

      failedCount += 1;
      results.push({
        detail: error.message,
        queueStatus: persisted?.queueStatus || "failed",
        requestId: claimed.requestId,
        sourceRecordId: claimed.sourceRecordId,
      });
    }
  }

  const queue = await refreshRevolutBusinessTransferQueueCounts();
  const executedAt = new Date().toISOString();

  state.revolutBusinessTransfers.lastError = failedCount
    ? `${failedCount} transfer(s) failed during execution`
    : null;
  state.revolutBusinessTransfers.lastExecutionAt = executedAt;
  state.revolutBusinessTransfers.lastExecutedCount = executedCount;
  state.revolutBusinessTransfers.lastExecutionMode = "explicit-opt-in";
  state.revolutBusinessTransfers.lastUpdated = executedAt;

  log(
    failedCount ? "warning" : "success",
    `🏦 Revolut Business execution attempted ${candidates.length} queue item(s); completed=${executedCount}, failed=${failedCount}, skipped=${skippedCount}`,
  );

  return {
    success: failedCount === 0,
    source: REVOLUT_BUSINESS_TRANSFER_EXECUTION_SOURCE,
    execution: {
      batchSize: maxItems,
      confirmExecution: true,
      endpoint: `${revolutConfig.revolutBaseUrl}/api/1.0/pay`,
      executionEnabled: true,
      method: "POST",
      optInField: revolutBusinessTransferExecutionConfig.optInField,
      refresh: refreshResult,
      scopeRequired: "PAY",
    },
    queue,
    summary: {
      attemptedCount: candidates.length,
      executedAt,
      executedCount,
      failedCount,
      skippedCount,
    },
    results,
  };
}

function buildRevolutMerchantOrderStatusPaths(orderId) {
  const encodedOrderId = encodeURIComponent(orderId);
  const basePaths = [revolutMerchantConfig.createOrderPath];

  if (
    !revolutMerchantConfig.createOrderPathExplicit &&
    revolutMerchantConfig.createOrderPath !== LEGACY_REVOLUT_MERCHANT_CREATE_ORDER_PATH
  ) {
    basePaths.push(LEGACY_REVOLUT_MERCHANT_CREATE_ORDER_PATH);
  }

  return [...new Set(basePaths)].map((basePath) => {
    const normalizedBasePath = normalizePath(
      basePath,
      DEFAULT_REVOLUT_MERCHANT_CREATE_ORDER_PATH,
    ).replace(/\/+$/u, "");

    return `${normalizedBasePath}/${encodedOrderId}`;
  });
}

function resolveRuntimeRefreshToken() {
  return revolutRuntime.refreshToken || revolutConfig.refreshToken || "";
}

function normalizeRevolutMerchantCurrency(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toUpperCase();
}

function normalizeRevolutMerchantOrderRequest(body) {
  const payload = body && typeof body === "object" ? body : {};
  const rawAmount = payload.amount;
  const amount = Number.parseInt(String(rawAmount ?? ""), 10);
  const currency = normalizeRevolutMerchantCurrency(payload.currency);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("amount must be a positive integer in minor units");
  }

  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new Error("currency must be a 3-letter ISO 4217 code");
  }

  const requestPayload = {
    amount,
    currency,
  };

  const optionalStringFields = [
    ["description", "description"],
    ["settlementCurrency", "settlement_currency"],
    ["redirectUrl", "redirect_url"],
    ["captureMode", "capture_mode"],
    ["authorisationType", "authorisation_type"],
    ["cancelAuthorisedAfter", "cancel_authorised_after"],
    ["expirePendingAfter", "expire_pending_after"],
    ["locationId", "location_id"],
    ["statementDescriptorSuffix", "statement_descriptor_suffix"],
    ["enforceChallenge", "enforce_challenge"],
  ];

  for (const [sourceKey, targetKey] of optionalStringFields) {
    const value = payload[sourceKey];

    if (typeof value === "string" && value.trim()) {
      requestPayload[targetKey] = value.trim();
    }
  }

  if (payload.customer && typeof payload.customer === "object") {
    const customer = {};

    if (typeof payload.customer.email === "string" && payload.customer.email.trim()) {
      customer.email = payload.customer.email.trim();
    }

    if (typeof payload.customer.fullName === "string" && payload.customer.fullName.trim()) {
      customer.full_name = payload.customer.fullName.trim();
    }

    if (Object.keys(customer).length > 0) {
      requestPayload.customer = customer;
    }
  }

  if (
    payload.metadata &&
    typeof payload.metadata === "object" &&
    !Array.isArray(payload.metadata)
  ) {
    requestPayload.metadata = payload.metadata;
  }

  if (typeof payload.merchantOrderReference === "string" && payload.merchantOrderReference.trim()) {
    requestPayload.merchant_order_data = {
      merchant_order_ext_ref: payload.merchantOrderReference.trim(),
    };
  }

  return requestPayload;
}

async function createRevolutMerchantOrder(body) {
  if (!revolutMerchantConfig.configured) {
    throw new Error(
      "Revolut Merchant API key must be configured via REVOLUT_MERCHANT_API_KEY or REVOLUT_API_SECRET",
    );
  }

  const requestPayload = normalizeRevolutMerchantOrderRequest(body);
  const requestPaths = [revolutMerchantConfig.createOrderPath];

  if (
    !revolutMerchantConfig.createOrderPathExplicit &&
    revolutMerchantConfig.createOrderPath !== LEGACY_REVOLUT_MERCHANT_CREATE_ORDER_PATH
  ) {
    requestPaths.push(LEGACY_REVOLUT_MERCHANT_CREATE_ORDER_PATH);
  }

  let payload = null;
  let lastError = null;
  let successfulRequestPath = null;
  let successfulRequestUrl = null;

  for (let index = 0; index < requestPaths.length; index += 1) {
    const requestPath = requestPaths[index];
    const requestUrl = new URL(requestPath, `${revolutMerchantConfig.apiBaseUrl}/`);
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${revolutMerchantConfig.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Revolut-Api-Version": revolutMerchantConfig.apiVersion,
        [BLUEPRINT_SYNC_HEADER_NAME]: BLUEPRINT_SYNC_REF,
        [SOVEREIGN_STATUS_HEADER_NAME]: SOVEREIGN_STATUS_HEADER_VALUE,
        "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
      },
      body: JSON.stringify(requestPayload),
    });
    payload = await parseResponsePayload(response);

    if (response.ok) {
      successfulRequestPath = requestPath;
      successfulRequestUrl = requestUrl.toString();
      break;
    }

    const detail =
      payload && typeof payload === "object"
        ? payload.message || payload.error || JSON.stringify(payload)
        : String(payload);
    const canRetryWithLegacyPath =
      index === 0 &&
      !revolutMerchantConfig.createOrderPathExplicit &&
      requestPath !== LEGACY_REVOLUT_MERCHANT_CREATE_ORDER_PATH &&
      [404, 405].includes(response.status);

    if (canRetryWithLegacyPath) {
      lastError = `Revolut Merchant API ${response.status}: ${detail}`;
      continue;
    }

    throw new Error(`Revolut Merchant API ${response.status}: ${detail}`);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error(lastError || "Revolut Merchant API returned an empty response payload");
  }

  state.revolutMerchant.lastCheckoutUrl =
    typeof payload?.checkout_url === "string" ? payload.checkout_url : null;
  state.revolutMerchant.lastCreateRequestPath = successfulRequestPath;
  state.revolutMerchant.lastCreateRequestUrl = successfulRequestUrl;
  state.revolutMerchant.lastCreatedAt =
    typeof payload?.created_at === "string" ? payload.created_at : new Date().toISOString();
  state.revolutMerchant.lastError = null;
  state.revolutMerchant.lastOrderId = typeof payload?.id === "string" ? payload.id : null;
  state.revolutMerchant.lastOrderState = typeof payload?.state === "string" ? payload.state : null;
  state.revolutMerchant.lastUpdated = new Date().toISOString();

  return {
    payload,
    requestPath: successfulRequestPath,
    requestUrl: successfulRequestUrl,
  };
}

function summarizeRevolutMerchantOrderRecord(payload, fallback = {}) {
  const orderPayload = payload && typeof payload === "object" ? payload : {};
  const orderId =
    normalizeTextValue(
      pickFirstNestedValue(orderPayload, [
        ["order", "id"],
        ["data", "order", "id"],
        ["resource", "order", "id"],
        ["order_id"],
        ["data", "order_id"],
        ["resource", "order_id"],
        ["id"],
      ]),
    ) ||
    fallback.orderId ||
    null;

  if (!orderId) {
    throw new Error("Revolut Merchant order payload missing order id");
  }

  const orderState =
    normalizeTextValue(
      pickFirstNestedValue(orderPayload, [
        ["order", "status"],
        ["data", "order", "status"],
        ["resource", "order", "status"],
        ["status"],
        ["state"],
      ]),
    ) ||
    fallback.orderState ||
    "unknown";
  const paymentStatus =
    normalizeTextValue(
      pickFirstNestedValue(orderPayload, [
        ["payment", "status"],
        ["data", "payment", "status"],
        ["resource", "payment", "status"],
        ["payment_status"],
        ["status"],
        ["state"],
      ]),
    ) ||
    fallback.paymentStatus ||
    orderState;
  const paymentId =
    normalizeTextValue(
      pickFirstNestedValue(orderPayload, [
        ["payment", "id"],
        ["data", "payment", "id"],
        ["resource", "payment", "id"],
        ["payment_id"],
      ]),
    ) ||
    fallback.paymentId ||
    null;
  const merchantOrderReference =
    normalizeTextValue(
      pickFirstNestedValue(orderPayload, [
        ["merchant_order_data", "merchant_order_ext_ref"],
        ["order", "merchant_order_ext_ref"],
        ["merchant_order_ext_ref"],
        ["merchant_order_reference"],
        ["order", "reference"],
        ["reference"],
      ]),
    ) ||
    fallback.merchantOrderReference ||
    null;
  const merchantReference =
    normalizeTextValue(
      pickFirstNestedValue(orderPayload, [
        ["merchant_reference"],
        ["merchant_ref"],
        ["payment", "reference"],
        ["reference"],
      ]),
    ) ||
    fallback.merchantReference ||
    null;
  const checkoutUrl =
    normalizeTextValue(
      pickFirstNestedValue(orderPayload, [["checkout_url"], ["checkoutUrl"], ["public_url"]]),
    ) ||
    fallback.checkoutUrl ||
    null;
  const amount = normalizeMoneyValue(
    pickFirstNestedValue(orderPayload, [
      ["amount"],
      ["order", "amount"],
      ["data", "order", "amount"],
      ["resource", "order", "amount"],
    ]),
    pickFirstNestedValue(orderPayload, [
      ["currency"],
      ["order", "currency"],
      ["data", "order", "currency"],
      ["resource", "order", "currency"],
    ]),
  );
  const customerEmail = extractRevolutCustomerEmail(orderPayload) || fallback.customerEmail || null;
  const createdAt =
    normalizeTimestampValue(
      pickFirstNestedValue(orderPayload, [
        ["created_at"],
        ["createdAt"],
        ["order", "created_at"],
        ["data", "order", "created_at"],
        ["resource", "order", "created_at"],
      ]),
    ) ||
    fallback.createdAt ||
    new Date().toISOString();
  const updatedAt =
    normalizeTimestampValue(
      pickFirstNestedValue(orderPayload, [
        ["updated_at"],
        ["updatedAt"],
        ["order", "updated_at"],
        ["data", "order", "updated_at"],
        ["resource", "order", "updated_at"],
      ]),
    ) ||
    fallback.updatedAt ||
    createdAt;

  return {
    orderId,
    orderState,
    paymentStatus,
    paymentId,
    merchantOrderReference,
    merchantReference,
    checkoutUrl,
    amountMinor: amount.amountMinor,
    amountValue: amount.amountValue,
    amountDisplay: formatCurrencyDisplay(amount.amountValue, amount.currency),
    currency: amount.currency,
    customerEmail,
    createdAt,
    updatedAt,
  };
}

async function upsertRevolutMerchantOrderRecord(record, payload) {
  if (!databasePool) {
    return false;
  }

  await withDatabaseClient((client) =>
    client.query(
      `
        INSERT INTO alphabet_revolut_merchant_orders (
          order_id,
          order_state,
          payment_status,
          payment_id,
          merchant_order_reference,
          merchant_reference,
          checkout_url,
          amount_minor,
          amount_value,
          currency,
          customer_email,
          created_at,
          updated_at,
          last_synced_at,
          raw_payload
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
          NOW(),
          $14::jsonb
        )
        ON CONFLICT (order_id) DO UPDATE SET
          order_state = EXCLUDED.order_state,
          payment_status = EXCLUDED.payment_status,
          payment_id = EXCLUDED.payment_id,
          merchant_order_reference = EXCLUDED.merchant_order_reference,
          merchant_reference = EXCLUDED.merchant_reference,
          checkout_url = EXCLUDED.checkout_url,
          amount_minor = EXCLUDED.amount_minor,
          amount_value = EXCLUDED.amount_value,
          currency = EXCLUDED.currency,
          customer_email = EXCLUDED.customer_email,
          created_at = COALESCE(alphabet_revolut_merchant_orders.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          last_synced_at = NOW(),
          raw_payload = EXCLUDED.raw_payload
      `,
      [
        record.orderId,
        record.orderState,
        record.paymentStatus,
        record.paymentId,
        record.merchantOrderReference,
        record.merchantReference,
        record.checkoutUrl,
        record.amountMinor,
        record.amountValue,
        record.currency,
        record.customerEmail,
        record.createdAt,
        record.updatedAt,
        stringifyJson(payload),
      ],
    ),
  );

  markDatabaseState({ connected: true, persistenceReady: true });
  return true;
}

async function persistRevolutMerchantOrderRecord(record, payload, reason) {
  if (!databasePool) {
    return {
      persisted: false,
      persistenceError: null,
    };
  }

  await ensureDatabaseReady(reason);
  await upsertRevolutMerchantOrderRecord(record, payload);

  return {
    persisted: true,
    persistenceError: null,
  };
}

async function fetchRevolutMerchantOrder(orderId) {
  if (!revolutMerchantConfig.configured) {
    throw new Error(
      "Revolut Merchant API key must be configured via REVOLUT_MERCHANT_API_KEY or REVOLUT_API_SECRET",
    );
  }

  const normalizedOrderId = normalizeTextValue(orderId);

  if (!normalizedOrderId) {
    throw new Error("Revolut Merchant order id is required");
  }

  const requestPaths = buildRevolutMerchantOrderStatusPaths(normalizedOrderId);
  let payload = null;
  let lastError = null;

  for (let index = 0; index < requestPaths.length; index += 1) {
    const requestPath = requestPaths[index];
    const requestUrl = new URL(requestPath, `${revolutMerchantConfig.apiBaseUrl}/`);
    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${revolutMerchantConfig.apiKey}`,
        Accept: "application/json",
        "Revolut-Api-Version": revolutMerchantConfig.apiVersion,
        [BLUEPRINT_SYNC_HEADER_NAME]: BLUEPRINT_SYNC_REF,
        [SOVEREIGN_STATUS_HEADER_NAME]: SOVEREIGN_STATUS_HEADER_VALUE,
        "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
      },
    });
    payload = await parseResponsePayload(response);

    if (response.ok) {
      return {
        payload,
        requestPath,
        requestUrl: requestUrl.toString(),
      };
    }

    const detail =
      payload && typeof payload === "object"
        ? payload.message || payload.error || JSON.stringify(payload)
        : String(payload);
    const canRetryWithLegacyPath =
      index === 0 &&
      !revolutMerchantConfig.createOrderPathExplicit &&
      requestPath !==
        `${LEGACY_REVOLUT_MERCHANT_CREATE_ORDER_PATH}/${encodeURIComponent(normalizedOrderId)}` &&
      [404, 405].includes(response.status);

    if (canRetryWithLegacyPath) {
      lastError = `Revolut Merchant API ${response.status}: ${detail}`;
      continue;
    }

    throw new Error(`Revolut Merchant API ${response.status}: ${detail}`);
  }

  throw new Error(lastError || "Revolut Merchant API returned an empty response payload");
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

async function fetchRevolutBusinessAccounts(accessToken, options = {}) {
  const requestLabel = options.requestLabel || "Revolut Business /accounts";
  const requestUrl = new URL(
    "/api/1.0/accounts",
    `${options.baseUrl || revolutConfig.revolutBaseUrl}/`,
  );
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    [BLUEPRINT_SYNC_HEADER_NAME]: BLUEPRINT_SYNC_REF,
    [SOVEREIGN_STATUS_HEADER_NAME]: SOVEREIGN_STATUS_HEADER_VALUE,
    "User-Agent": "AlphabetHarvester/1.0 (OpenClaw)",
  };

  if (options.apiVersion) {
    headers["Revolut-Api-Version"] = options.apiVersion;
  }

  const response = await fetch(requestUrl, {
    headers,
  });
  const payload = await parseResponsePayload(response);

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? payload.message || payload.error || JSON.stringify(payload)
        : String(payload);

    throw new Error(`${requestLabel} ${response.status}: ${detail}`);
  }

  return {
    accounts: normalizeRevolutBusinessAccountsPayload(payload),
    requestUrl: requestUrl.toString(),
  };
}

async function fetchRevolutBusinessAccountsViaMerchantFallback() {
  if (!revolutMerchantConfig.configured || !revolutMerchantConfig.apiKey) {
    throw new Error("Revolut Merchant API fallback is not configured");
  }

  return fetchRevolutBusinessAccounts(revolutMerchantConfig.apiKey, {
    apiVersion: revolutMerchantConfig.apiVersion,
    requestLabel: "Revolut Business /accounts via Merchant API fallback",
  });
}

async function discoverRevolutBusinessSourceAccount({ force = false, reason = "status" } = {}) {
  if (airtableTransferConfig.sourceAccountId) {
    revolutBusinessSourceAccountDiscoveryRuntime.lastStatus = "configured-via-env";
    revolutBusinessSourceAccountDiscoveryRuntime.lastTrigger = "env";
    syncRevolutBusinessTransferState();
    return getRevolutBusinessSourceAccountDiscoverySnapshot();
  }

  const discoveryMode = getRevolutBusinessSourceAccountDiscoveryMode();
  const discoveryModeLabel =
    discoveryMode === "merchant-api-fallback"
      ? "Merchant API fallback"
      : "Revolut Business refresh";

  if (!discoveryMode) {
    revolutBusinessSourceAccountDiscoveryRuntime.lastError =
      getRevolutBusinessSourceAccountDiscoveryUnavailableMessage();
    revolutBusinessSourceAccountDiscoveryRuntime.lastStatus = "unavailable";
    revolutBusinessSourceAccountDiscoveryRuntime.lastTrigger = reason;
    syncRevolutBusinessTransferState();
    return getRevolutBusinessSourceAccountDiscoverySnapshot();
  }

  const lastAttemptTimeMs = revolutBusinessSourceAccountDiscoveryRuntime.lastAttemptAt
    ? Date.parse(revolutBusinessSourceAccountDiscoveryRuntime.lastAttemptAt)
    : Number.NaN;

  if (
    !force &&
    Number.isFinite(lastAttemptTimeMs) &&
    Date.now() - lastAttemptTimeMs < REVOLUT_BUSINESS_SOURCE_ACCOUNT_DISCOVERY_CACHE_TTL_MS &&
    revolutBusinessSourceAccountDiscoveryRuntime.lastStatus !== "refreshing"
  ) {
    syncRevolutBusinessTransferState();
    return getRevolutBusinessSourceAccountDiscoverySnapshot();
  }

  if (!force && revolutBusinessSourceAccountDiscoveryRuntime.inFlightPromise) {
    return revolutBusinessSourceAccountDiscoveryRuntime.inFlightPromise;
  }

  revolutBusinessSourceAccountDiscoveryRuntime.inFlightPromise = (async () => {
    const attemptedAt = new Date().toISOString();
    const previousSourceAccountId = revolutBusinessSourceAccountDiscoveryRuntime.sourceAccountId;

    revolutBusinessSourceAccountDiscoveryRuntime.lastAttemptAt = attemptedAt;
    revolutBusinessSourceAccountDiscoveryRuntime.lastError = null;
    revolutBusinessSourceAccountDiscoveryRuntime.lastStatus = "refreshing";
    revolutBusinessSourceAccountDiscoveryRuntime.lastTrigger = reason;
    syncRevolutBusinessTransferState();

    try {
      let accounts = [];
      let requestUrl = null;

      if (discoveryMode === "merchant-api-fallback") {
        ({ accounts, requestUrl } = await fetchRevolutBusinessAccountsViaMerchantFallback());
      } else {
        await refreshRevolutAccessToken();

        if (!revolutRuntime.accessToken) {
          throw new Error("Revolut access token is unavailable after refresh");
        }

        ({ accounts, requestUrl } = await fetchRevolutBusinessAccounts(revolutRuntime.accessToken));
      }

      const selection = decorateRevolutBusinessSourceAccountSelection(
        chooseRevolutBusinessSourceAccount(accounts, airtableTransferConfig.defaultCurrency),
        discoveryMode,
      );

      revolutBusinessSourceAccountDiscoveryRuntime.accounts = accounts;
      revolutBusinessSourceAccountDiscoveryRuntime.lastRequestUrl = requestUrl;
      revolutBusinessSourceAccountDiscoveryRuntime.sourceAccountId = selection.account?.id || null;
      revolutBusinessSourceAccountDiscoveryRuntime.sourceAccountIdSource = selection.source;
      revolutBusinessSourceAccountDiscoveryRuntime.sourceSelectionReason = selection.reason;
      revolutBusinessSourceAccountDiscoveryRuntime.successfulAt = attemptedAt;

      if (selection.account) {
        revolutBusinessSourceAccountDiscoveryRuntime.lastStatus =
          discoveryMode === "merchant-api-fallback" ? "resolved-via-merchant-fallback" : "resolved";
        syncRevolutBusinessTransferState();

        if (previousSourceAccountId !== selection.account.id) {
          log(
            "info",
            `🏦 Revolut Business source account auto-discovered via ${discoveryModeLabel}: ${selection.account.id}${selection.account.currency ? ` (${selection.account.currency})` : ""}. ${selection.reason}.`,
          );
        }
      } else {
        revolutBusinessSourceAccountDiscoveryRuntime.lastError = selection.reason;
        revolutBusinessSourceAccountDiscoveryRuntime.lastStatus = accounts.length
          ? "ambiguous"
          : "empty";
        syncRevolutBusinessTransferState();

        log(
          "warning",
          `🏦 Revolut Business source account auto-discovery via ${discoveryModeLabel} did not resolve a single account. ${selection.reason}.`,
        );
      }
    } catch (error) {
      revolutBusinessSourceAccountDiscoveryRuntime.lastError = error.message;
      revolutBusinessSourceAccountDiscoveryRuntime.lastStatus =
        discoveryMode === "merchant-api-fallback" ? "merchant-fallback-error" : "error";
      syncRevolutBusinessTransferState();

      log(
        "warning",
        `🏦 Revolut Business source account auto-discovery via ${discoveryModeLabel} failed: ${error.message}`,
      );
    }

    return getRevolutBusinessSourceAccountDiscoverySnapshot();
  })().finally(() => {
    revolutBusinessSourceAccountDiscoveryRuntime.inFlightPromise = null;
  });

  return revolutBusinessSourceAccountDiscoveryRuntime.inFlightPromise;
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
      await client.query(PAYPAL_WEBHOOK_EVENTS_TABLE_SQL);
      await client.query(PAYPAL_WEBHOOK_EVENTS_RECEIVED_AT_INDEX_SQL);
      await client.query(PAYPAL_WEBHOOK_EVENTS_TYPE_INDEX_SQL);
      await client.query(REVOLUT_MERCHANT_ORDERS_TABLE_SQL);
      for (const statement of REVOLUT_MERCHANT_ORDERS_ALTER_SQL) {
        await client.query(statement);
      }
      await client.query(REVOLUT_MERCHANT_ORDERS_UPDATED_AT_INDEX_SQL);
      await client.query(REVOLUT_MERCHANT_ORDERS_STATE_INDEX_SQL);
      await client.query(REVOLUT_MERCHANT_EVENTS_TABLE_SQL);
      for (const statement of REVOLUT_MERCHANT_EVENTS_ALTER_SQL) {
        await client.query(statement);
      }
      await client.query(REVOLUT_MERCHANT_EVENTS_RECEIVED_AT_INDEX_SQL);
      await client.query(REVOLUT_MERCHANT_EVENTS_TYPE_INDEX_SQL);
      await client.query(REVOLUT_MERCHANT_EVENTS_ORDER_ID_INDEX_SQL);
      await client.query(REVOLUT_MERCHANT_EVENTS_MERCHANT_ORDER_REF_INDEX_SQL);
      await client.query(REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE_SQL);
      for (const statement of REVOLUT_BUSINESS_TRANSFER_QUEUE_ALTER_SQL) {
        await client.query(statement);
      }
      await client.query(REVOLUT_BUSINESS_TRANSFER_QUEUE_UPDATED_AT_INDEX_SQL);
      await client.query(REVOLUT_BUSINESS_TRANSFER_QUEUE_STATUS_INDEX_SQL);
      await client.query(REVOLUT_BUSINESS_TRANSFER_QUEUE_EXECUTED_AT_INDEX_SQL);
    });

    await backfillRevolutMerchantExecutiveFields();
    await seedConfiguredRevolutMerchantBackfill();

    markDatabaseState({ connected: true, persistenceReady: true });
    await refreshStripePaymentCount();
    await refreshPayPalWebhookEventCount();
    await refreshRevolutMerchantEventCount();
    await refreshRevolutBusinessTransferQueueCounts();
    log("success", `🗄️ Connected to PostgreSQL target ${databaseConfig.connectionLabel}`);
    log("success", "🗄️ Shopify order persistence ready in alpacoredb");
    log("success", "🗄️ Stripe payment persistence ready in alpacoredb");
    log("success", "🗄️ PayPal webhook persistence ready in alpacoredb");
    log("success", "🗄️ Revolut merchant persistence ready in alpacoredb");
    log("success", "🗄️ Revolut Business transfer queue ready in alpacoredb");
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

async function refreshPayPalWebhookEventCount() {
  if (!databasePool) {
    state.paypal.persistedCount = 0;
    return 0;
  }

  const result = await withDatabaseClient((client) =>
    client.query("SELECT COUNT(*)::int AS count FROM alphabet_paypal_webhook_events"),
  );
  const count = Number(result.rows[0]?.count || 0);

  state.paypal.persistedCount = count;
  state.paypal.lastUpdated = new Date().toISOString();
  return count;
}

async function refreshRevolutMerchantEventCount() {
  if (!databasePool) {
    state.revolut.persistedCount = 0;
    return 0;
  }

  const result = await withDatabaseClient((client) =>
    client.query("SELECT COUNT(*)::int AS count FROM alphabet_revolut_merchant_events"),
  );
  const count = Number(result.rows[0]?.count || 0);

  state.revolut.persistedCount = count;
  state.revolut.lastUpdated = new Date().toISOString();
  return count;
}

async function readRevolutMerchantEvents(limit) {
  if (!databasePool) {
    return [];
  }

  const result = await withDatabaseClient((client) =>
    client.query(
      `
        SELECT
          event_id,
          event_type,
          source,
          order_id,
          payment_id,
          merchant_order_reference,
          merchant_reference,
          payment_status,
          settlement_status,
          amount_minor,
          amount_value,
          currency,
          settlement_amount_minor,
          settlement_amount_value,
          settlement_currency,
          customer_email,
          amount_display,
          settlement_amount_display,
          created_at,
          settled_at,
          webhook_id,
          request_id,
          public_url,
          webhook_url,
          target_assets_eur,
          received_at
        FROM alphabet_revolut_merchant_events
        ORDER BY received_at DESC
        LIMIT $1
      `,
      [limit],
    ),
  );

  return result.rows.map(mapRevolutMerchantEventRow);
}

async function readRevolutMerchantOrders(limit) {
  if (!databasePool) {
    return [];
  }

  const result = await withDatabaseClient((client) =>
    client.query(
      `
        SELECT
          order_id,
          order_state,
          payment_status,
          payment_id,
          merchant_order_reference,
          merchant_reference,
          checkout_url,
          amount_minor,
          amount_value,
          currency,
          customer_email,
          created_at,
          updated_at,
          last_synced_at
        FROM alphabet_revolut_merchant_orders
        ORDER BY updated_at DESC NULLS LAST, last_synced_at DESC
        LIMIT $1
      `,
      [limit],
    ),
  );

  return result.rows.map(mapRevolutMerchantOrderRow);
}

async function readRevolutMerchantExecutiveSummary() {
  if (!databasePool) {
    return {
      persistedCount: 0,
      customerEmailCount: 0,
      latestReceivedAt: null,
      totalAmountDisplay: null,
      totalSettlementAmountDisplay: null,
      totalAmountValue: null,
      totalSettlementAmountValue: null,
    };
  }

  const result = await withDatabaseClient((client) =>
    client.query(`
      SELECT
        COUNT(*)::int AS persisted_count,
        COUNT(DISTINCT NULLIF(customer_email, ''))::int AS customer_email_count,
        MAX(received_at) AS latest_received_at,
        COALESCE(SUM(CASE WHEN currency = 'EUR' THEN amount_value ELSE 0 END), 0)::text AS total_amount_value,
        COALESCE(SUM(CASE WHEN settlement_currency = 'EUR' THEN settlement_amount_value ELSE 0 END), 0)::text AS total_settlement_amount_value
      FROM alphabet_revolut_merchant_events
    `),
  );
  const row = result.rows[0] || {};
  const totalAmountValue = row.total_amount_value === null ? null : Number(row.total_amount_value);
  const totalSettlementAmountValue =
    row.total_settlement_amount_value === null ? null : Number(row.total_settlement_amount_value);

  return {
    persistedCount: Number(row.persisted_count || 0),
    customerEmailCount: Number(row.customer_email_count || 0),
    latestReceivedAt: row.latest_received_at || null,
    totalAmountValue,
    totalSettlementAmountValue,
    totalAmountDisplay:
      totalAmountValue === null ? null : formatCurrencyDisplay(totalAmountValue, "EUR"),
    totalSettlementAmountDisplay:
      totalSettlementAmountValue === null
        ? null
        : formatCurrencyDisplay(totalSettlementAmountValue, "EUR"),
  };
}

function resolveRevolutExecutiveSummary(summary) {
  const persistedCount = Number(summary?.persistedCount || 0);
  const totalAmountValue = Number(summary?.totalAmountValue || 0);
  const totalSettlementAmountValue = Number(summary?.totalSettlementAmountValue || 0);
  const useConfirmedOverride =
    empireConfig.revolutConfirmedTotalConfigured &&
    persistedCount === 0 &&
    totalAmountValue === 0 &&
    totalSettlementAmountValue === 0;

  if (!useConfirmedOverride) {
    return {
      ...summary,
      overrideActive: false,
      source: "database",
    };
  }

  const confirmedTotalEur = empireConfig.revolutConfirmedTotalEur;
  const confirmedTotalDisplay = formatCurrencyDisplay(confirmedTotalEur, "EUR");

  return {
    ...summary,
    persistedCount: confirmedTotalEur > 0 ? 1 : 0,
    totalAmountValue: confirmedTotalEur,
    totalSettlementAmountValue: confirmedTotalEur,
    totalAmountDisplay: confirmedTotalDisplay,
    totalSettlementAmountDisplay: confirmedTotalDisplay,
    overrideActive: true,
    source: "confirmed-override",
  };
}

async function readEmpireDashboardSnapshot() {
  const [market, rawRevolutSummary] = await Promise.all([
    fetchEmpireMarketSnapshot(),
    databasePool && state.database.connected
      ? readRevolutMerchantExecutiveSummary()
      : Promise.resolve({
          customerEmailCount: 0,
          latestReceivedAt: null,
          persistedCount: state.revolut.persistedCount,
          totalAmountDisplay: formatCurrencyDisplay(0, "EUR"),
          totalAmountValue: 0,
        }),
  ]);
  const revolutSummary = resolveRevolutExecutiveSummary(rawRevolutSummary);
  const paypalRecovery = calculatePaypalRecoverySnapshot();
  const revolutValueEur = Number(revolutSummary.totalAmountValue || 0);
  const totalNetWorthEur =
    market.summary.totalValueEur + revolutValueEur + paypalRecovery.targetValueEur;

  return {
    market,
    paypalRecovery,
    revolut: {
      latestReceivedAt: revolutSummary.latestReceivedAt || null,
      persistedCount: Number(revolutSummary.persistedCount || state.revolut.persistedCount || 0),
      overrideActive: Boolean(revolutSummary.overrideActive),
      source: revolutSummary.source || "database",
      totalAmountDisplay:
        revolutSummary.totalAmountDisplay || formatCurrencyDisplay(revolutValueEur, "EUR"),
      totalAmountValue: revolutValueEur,
    },
    summary: {
      cryptoValueDisplay: market.summary.totalValueDisplay,
      cryptoValueEur: market.summary.totalValueEur,
      totalNetWorthDisplay: formatCurrencyDisplay(totalNetWorthEur, "EUR"),
      totalNetWorthEur,
      lastUpdated: market.fetchedAt,
    },
  };
}

async function backfillRevolutMerchantExecutiveFields() {
  if (!databasePool) {
    return 0;
  }

  return withDatabaseClient(async (client) => {
    const result = await client.query(`
      SELECT
        event_id,
        raw_payload,
        customer_email,
        amount_value,
        currency,
        amount_display,
        settlement_amount_value,
        settlement_currency,
        settlement_amount_display
      FROM alphabet_revolut_merchant_events
      WHERE customer_email IS NULL
        OR amount_display IS NULL
        OR settlement_amount_display IS NULL
    `);

    let updatedCount = 0;

    for (const row of result.rows) {
      const payload = row.raw_payload && typeof row.raw_payload === "object" ? row.raw_payload : {};
      const customerEmail = row.customer_email || extractRevolutCustomerEmail(payload);
      const amountValue = row.amount_value === null ? null : Number(row.amount_value);
      const settlementAmountValue =
        row.settlement_amount_value === null ? null : Number(row.settlement_amount_value);
      const amountDisplay =
        row.amount_display ||
        (amountValue === null ? null : formatCurrencyDisplay(amountValue, row.currency));
      const settlementAmountDisplay =
        row.settlement_amount_display ||
        (settlementAmountValue === null
          ? null
          : formatCurrencyDisplay(settlementAmountValue, row.settlement_currency));

      await client.query(
        `
          UPDATE alphabet_revolut_merchant_events
          SET
            customer_email = $2,
            amount_display = $3,
            settlement_amount_display = $4
          WHERE event_id = $1
        `,
        [row.event_id, customerEmail, amountDisplay, settlementAmountDisplay],
      );
      updatedCount += 1;
    }

    return updatedCount;
  });
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

async function persistQueuedPayPalSandboxWebhookEvent(summary, payload) {
  if (!databasePool) {
    return;
  }

  await withDatabaseClient((client) =>
    client.query(
      `
        INSERT INTO alphabet_paypal_webhook_events (
          event_id,
          event_type,
          resource_id,
          resource_type,
          resource_status,
          amount_value,
          currency,
          amount_display,
          webhook_id,
          transmission_id,
          transmission_time,
          transmission_sig,
          auth_algo,
          cert_url,
          public_url,
          webhook_url,
          verification_status,
          created_at,
          raw_payload
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
          $17,
          $18,
          $19::jsonb
        )
        ON CONFLICT (event_id) DO UPDATE SET
          event_type = EXCLUDED.event_type,
          resource_id = EXCLUDED.resource_id,
          resource_type = EXCLUDED.resource_type,
          resource_status = EXCLUDED.resource_status,
          amount_value = EXCLUDED.amount_value,
          currency = EXCLUDED.currency,
          amount_display = EXCLUDED.amount_display,
          webhook_id = EXCLUDED.webhook_id,
          transmission_id = EXCLUDED.transmission_id,
          transmission_time = EXCLUDED.transmission_time,
          transmission_sig = EXCLUDED.transmission_sig,
          auth_algo = EXCLUDED.auth_algo,
          cert_url = EXCLUDED.cert_url,
          public_url = EXCLUDED.public_url,
          webhook_url = EXCLUDED.webhook_url,
          verification_status = EXCLUDED.verification_status,
          created_at = EXCLUDED.created_at,
          raw_payload = EXCLUDED.raw_payload,
          received_at = NOW()
      `,
      [
        summary.eventId,
        summary.eventType,
        summary.resourceId,
        summary.resourceType,
        summary.resourceStatus,
        summary.amountValue,
        summary.currency,
        summary.amountDisplay,
        summary.webhookId,
        summary.transmissionId,
        summary.transmissionTime,
        summary.transmissionSig,
        summary.authAlgo,
        summary.certUrl,
        summary.publicUrl,
        summary.webhookUrl,
        summary.verificationStatus,
        summary.createdAt,
        stringifyJson(payload),
      ],
    ),
  );

  markDatabaseState({ connected: true, persistenceReady: true });
  await refreshPayPalWebhookEventCount();
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

async function persistQueuedRevolutMerchantEvent(summary, payload) {
  if (!databasePool) {
    return;
  }

  await withDatabaseClient((client) =>
    client.query(
      `
        INSERT INTO alphabet_revolut_merchant_events (
          event_id,
          event_type,
          source,
          order_id,
          payment_id,
          merchant_order_reference,
          merchant_reference,
          payment_status,
          settlement_status,
          amount_minor,
          amount_value,
          currency,
          settlement_amount_minor,
          settlement_amount_value,
          settlement_currency,
          customer_email,
          amount_display,
          settlement_amount_display,
          created_at,
          settled_at,
          webhook_id,
          request_id,
          public_url,
          webhook_url,
          target_assets_eur,
          raw_payload
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
          $17,
          $18,
          $19,
          $20,
          $21,
          $22,
          $23,
          $24,
          $25,
          $26::jsonb
        )
        ON CONFLICT (event_id) DO UPDATE SET
          event_type = EXCLUDED.event_type,
          source = EXCLUDED.source,
          order_id = EXCLUDED.order_id,
          payment_id = EXCLUDED.payment_id,
          merchant_order_reference = EXCLUDED.merchant_order_reference,
          merchant_reference = EXCLUDED.merchant_reference,
          payment_status = EXCLUDED.payment_status,
          settlement_status = EXCLUDED.settlement_status,
          amount_minor = EXCLUDED.amount_minor,
          amount_value = EXCLUDED.amount_value,
          currency = EXCLUDED.currency,
          settlement_amount_minor = EXCLUDED.settlement_amount_minor,
          settlement_amount_value = EXCLUDED.settlement_amount_value,
          settlement_currency = EXCLUDED.settlement_currency,
          customer_email = EXCLUDED.customer_email,
          amount_display = EXCLUDED.amount_display,
          settlement_amount_display = EXCLUDED.settlement_amount_display,
          created_at = EXCLUDED.created_at,
          settled_at = EXCLUDED.settled_at,
          webhook_id = EXCLUDED.webhook_id,
          request_id = EXCLUDED.request_id,
          public_url = EXCLUDED.public_url,
          webhook_url = EXCLUDED.webhook_url,
          target_assets_eur = EXCLUDED.target_assets_eur,
          raw_payload = EXCLUDED.raw_payload,
          received_at = NOW()
      `,
      [
        summary.eventId,
        summary.eventType,
        summary.source,
        summary.orderId,
        summary.paymentId,
        summary.merchantOrderReference,
        summary.merchantReference,
        summary.paymentStatus,
        summary.settlementStatus,
        summary.amountMinor,
        summary.amountValue,
        summary.currency,
        summary.settlementAmountMinor,
        summary.settlementAmountValue,
        summary.settlementCurrency,
        summary.customerEmail,
        summary.amountDisplay,
        summary.settlementAmountDisplay,
        summary.createdAt,
        summary.settledAt,
        summary.webhookId,
        summary.requestId,
        summary.publicUrl,
        summary.webhookUrl,
        summary.targetAssetsEur,
        stringifyJson(payload),
      ],
    ),
  );

  markDatabaseState({ connected: true, persistenceReady: true });
  await refreshRevolutMerchantEventCount();
}

function createConfiguredRevolutMerchantBackfill() {
  const amountValue = empireConfig.revolutConfirmedTotalEur;

  if (!empireConfig.revolutConfirmedTotalConfigured || amountValue <= 0) {
    return null;
  }

  const amountMinor = Math.round(amountValue * 100);
  const summary = {
    amountDisplay: formatCurrencyDisplay(amountValue, REVOLUT_CONFIRMED_BACKFILL_EVENT.currency),
    amountMinor,
    amountValue,
    createdAt: REVOLUT_CONFIRMED_BACKFILL_EVENT.createdAt,
    currency: REVOLUT_CONFIRMED_BACKFILL_EVENT.currency,
    customerEmail: null,
    eventId: REVOLUT_CONFIRMED_BACKFILL_EVENT.eventId,
    eventType: REVOLUT_CONFIRMED_BACKFILL_EVENT.eventType,
    merchantOrderReference: REVOLUT_CONFIRMED_BACKFILL_EVENT.merchantOrderReference,
    merchantReference: REVOLUT_CONFIRMED_BACKFILL_EVENT.merchantReference,
    orderId: REVOLUT_CONFIRMED_BACKFILL_EVENT.orderId,
    paymentId: REVOLUT_CONFIRMED_BACKFILL_EVENT.paymentId,
    paymentStatus: REVOLUT_CONFIRMED_BACKFILL_EVENT.paymentStatus,
    publicUrl: serviceConfig.publicUrl || null,
    requestId: null,
    settlementAmountDisplay: formatCurrencyDisplay(
      amountValue,
      REVOLUT_CONFIRMED_BACKFILL_EVENT.settlementCurrency,
    ),
    settlementAmountMinor: amountMinor,
    settlementAmountValue: amountValue,
    settlementCurrency: REVOLUT_CONFIRMED_BACKFILL_EVENT.settlementCurrency,
    settlementStatus: REVOLUT_CONFIRMED_BACKFILL_EVENT.settlementStatus,
    settledAt: REVOLUT_CONFIRMED_BACKFILL_EVENT.settledAt,
    source: REVOLUT_MERCHANT_BACKFILL_SOURCE,
    targetAssetsEur: REVOLUT_MERCHANT_TARGET_ASSETS_EUR,
    webhookId: REVOLUT_CONFIRMED_BACKFILL_EVENT.webhookId,
    webhookUrl: getRevolutMerchantWebhookUrl(),
  };

  return {
    payload: {
      id: summary.eventId,
      merchant_reference: summary.merchantReference,
      order: {
        amount: {
          currency: summary.currency,
          value: amountMinor,
        },
        created_at: summary.createdAt,
        id: summary.orderId,
        merchant_order_ext_ref: summary.merchantOrderReference,
        status: "completed",
      },
      payment: {
        amount: {
          currency: summary.currency,
          value: amountMinor,
        },
        id: summary.paymentId,
        status: summary.paymentStatus,
      },
      settlement: {
        amount: {
          currency: summary.settlementCurrency,
          value: amountMinor,
        },
        settled_at: summary.settledAt,
        status: summary.settlementStatus,
      },
      type: summary.eventType,
    },
    summary,
  };
}

async function seedConfiguredRevolutMerchantBackfill() {
  const configuredBackfill = createConfiguredRevolutMerchantBackfill();

  if (!configuredBackfill || !databasePool) {
    return 0;
  }

  const summary = await readRevolutMerchantExecutiveSummary();

  if (Number(summary.persistedCount || 0) > 0) {
    return Number(summary.persistedCount || 0);
  }

  await persistQueuedRevolutMerchantEvent(configuredBackfill.summary, configuredBackfill.payload);
  log(
    "success",
    `💶 Seeded confirmed Revolut merchant backfill into alphabet_revolut_merchant_events: ${configuredBackfill.summary.eventId}`,
  );

  return Number(state.revolut.persistedCount || 0);
}

async function runStripeHealthCheck() {
  const healthCheckPath = stripeConfig.healthCheckPath.replace(/^\/+|\/+$/gu, "");
  const healthPayload = await callStripeApi(healthCheckPath, null, { forceSecretRefresh: true });
  const account = healthCheckPath === "account" ? healthPayload : await callStripeApi("account");
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

async function runPayPalSandboxHealthCheck() {
  const checkedAt = new Date().toISOString();

  await resolvePayPalSandboxAccessToken({ forceRefresh: true });

  state.paypal.lastError = null;
  state.paypal.lastUpdated = checkedAt;

  return {
    accessTokenExpiresAt: state.paypal.accessTokenExpiresAt,
    apiBaseUrl: paypalSandboxConfig.apiBaseUrl,
    checkedAt,
    configured: paypalSandboxConfig.configured,
    credentialsConfigured: paypalSandboxConfig.credentialsConfigured,
    environment: paypalSandboxConfig.environment,
    webhookConfigured: paypalSandboxConfig.webhookConfigured,
    webhookUrl: getPayPalSandboxWebhookUrl(),
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

function hasRevolutMerchantSignal(req, alphabetSource) {
  const candidates = [
    alphabetSource === REVOLUT_MERCHANT_BACKFILL_SOURCE ? alphabetSource : "",
    req.get("x-revolut-event"),
    req.get("x-revolut-webhook-id"),
    req.get("x-request-id"),
    req.body?.id,
    req.body?.type,
  ];

  return candidates.some((candidate) => {
    if (typeof candidate === "string") {
      return candidate.trim().length > 0;
    }

    return candidate !== null && candidate !== undefined;
  });
}

function summarizeRevolutMerchantEvent(req, alphabetSource) {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const webhookId = req.get("x-revolut-webhook-id")?.trim() || null;
  const requestId = req.get("x-request-id")?.trim() || null;
  const payloadId =
    typeof payload?.id === "string" || typeof payload?.id === "number" ? String(payload.id) : null;
  const eventTypeHeader = req.get("x-revolut-event")?.trim() || "";
  const payloadType = typeof payload?.type === "string" ? payload.type.trim() : "";
  const source = alphabetSource || "revolut-merchant";
  const orderId = normalizeTextValue(
    pickFirstNestedValue(payload, [
      ["order", "id"],
      ["data", "order", "id"],
      ["resource", "order", "id"],
      ["order_id"],
      ["data", "order_id"],
      ["resource", "order_id"],
    ]),
  );
  const paymentId = normalizeTextValue(
    pickFirstNestedValue(payload, [
      ["payment", "id"],
      ["data", "payment", "id"],
      ["resource", "payment", "id"],
      ["payment_id"],
      ["transaction_id"],
      ["data", "payment_id"],
    ]),
  );
  const merchantOrderReference = normalizeTextValue(
    pickFirstNestedValue(payload, [
      ["order", "merchant_order_ext_ref"],
      ["data", "order", "merchant_order_ext_ref"],
      ["merchant_order_ext_ref"],
      ["order", "merchant_order_reference"],
      ["merchant_order_reference"],
      ["order", "merchant_order_ref"],
      ["merchant_order_ref"],
      ["order", "reference"],
    ]),
  );
  const merchantReference = normalizeTextValue(
    pickFirstNestedValue(payload, [
      ["merchant_reference"],
      ["merchant_ref"],
      ["reference"],
      ["payment", "reference"],
      ["data", "reference"],
      ["data", "payment", "reference"],
    ]),
  );
  const paymentStatus = normalizeTextValue(
    pickFirstNestedValue(payload, [
      ["payment", "status"],
      ["order", "status"],
      ["status"],
      ["state"],
      ["data", "status"],
      ["data", "payment", "status"],
    ]),
  );
  const amountSource =
    pickFirstNestedValue(payload, [
      ["payment", "amount"],
      ["order", "amount"],
      ["amount"],
      ["data", "payment", "amount"],
      ["data", "order", "amount"],
      ["data", "amount"],
    ]) ?? null;
  const amountCurrency = pickFirstNestedValue(payload, [
    ["payment", "currency"],
    ["order", "currency"],
    ["currency"],
    ["data", "payment", "currency"],
    ["data", "order", "currency"],
    ["data", "currency"],
  ]);
  const amount = normalizeMoneyValue(amountSource, amountCurrency);
  const settlementSource =
    pickFirstNestedValue(payload, [
      ["settlement", "amount"],
      ["settlement_amount"],
      ["data", "settlement", "amount"],
    ]) ?? null;
  const settlementCurrency = pickFirstNestedValue(payload, [
    ["settlement", "currency"],
    ["settlement_currency"],
    ["data", "settlement", "currency"],
  ]);
  const settlement = normalizeMoneyValue(settlementSource, settlementCurrency);
  const settlementStatus = normalizeTextValue(
    pickFirstNestedValue(payload, [
      ["settlement", "status"],
      ["settlement_status"],
      ["data", "settlement", "status"],
    ]),
  );
  const customerEmail = extractRevolutCustomerEmail(payload);
  const createdAt = normalizeTimestampValue(
    pickFirstNestedValue(payload, [
      ["created_at"],
      ["createdAt"],
      ["order", "created_at"],
      ["order", "createdAt"],
      ["data", "created_at"],
      ["data", "order", "created_at"],
    ]),
  );
  const settledAt = normalizeTimestampValue(
    pickFirstNestedValue(payload, [
      ["settlement", "settled_at"],
      ["settled_at"],
      ["settlement", "created_at"],
      ["data", "settlement", "settled_at"],
    ]),
  );

  return {
    eventId: payloadId || webhookId || requestId || randomUUID(),
    eventType:
      eventTypeHeader ||
      payloadType ||
      (source === REVOLUT_MERCHANT_BACKFILL_SOURCE ? "manual-backfill" : "revolut-merchant"),
    source,
    orderId,
    paymentId,
    merchantOrderReference,
    merchantReference,
    paymentStatus,
    settlementStatus,
    amountMinor: amount.amountMinor,
    amountValue: amount.amountValue,
    currency: amount.currency,
    settlementAmountMinor: settlement.amountMinor,
    settlementAmountValue: settlement.amountValue,
    settlementCurrency: settlement.currency,
    customerEmail,
    amountDisplay:
      amount.amountValue === null
        ? null
        : formatCurrencyDisplay(amount.amountValue, amount.currency),
    settlementAmountDisplay:
      settlement.amountValue === null
        ? null
        : formatCurrencyDisplay(settlement.amountValue, settlement.currency),
    createdAt,
    settledAt,
    webhookId,
    requestId,
    publicUrl: getHarvesterPublicUrl(req),
    webhookUrl: getRevolutMerchantWebhookUrl(req),
    targetAssetsEur: REVOLUT_MERCHANT_TARGET_ASSETS_EUR,
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
    limit: limit ? Number.parseInt(limit, 10) : null,
    remaining: remaining ? Number.parseInt(remaining, 10) : null,
    reset: reset ? Number.parseInt(reset, 10) : null,
    used: used ? Number.parseInt(used, 10) : null,
    resource: resource || "core",
  };
  state.github.lastUpdated = new Date().toISOString();
}

function countTargetsByStatus(status) {
  return state.targets.filter((target) => target.status === status).length;
}

function buildRuntimeSnapshot() {
  return {
    mode: runtimeConfig.mode,
    stealthMode: runtimeConfig.stealthMode,
    loadDefaultTargets: runtimeConfig.loadDefaultTargets,
    allowStartupNetworkActions: runtimeConfig.allowStartupNetworkActions,
    workerCount: state.stats.workers,
    targets: {
      total: state.targets.length,
      pending: countTargetsByStatus("pending"),
      active: countTargetsByStatus("active"),
      completed: countTargetsByStatus("completed"),
      failed: countTargetsByStatus("failed"),
    },
  };
}

function buildArniResponse(prompt) {
  const normalizedPrompt = String(prompt || "")
    .trim()
    .toLowerCase();
  const ready = !state.database.configured || state.database.connected;
  const runtime = buildRuntimeSnapshot();
  const baseResponse = runtime.stealthMode
    ? "Stealth mode is active. Startup network work and default target harvesting stay disabled until you enable them explicitly."
    : "Arni local control plane is online.";

  if (
    normalizedPrompt.includes("status") ||
    normalizedPrompt.includes("health") ||
    normalizedPrompt.includes("ready")
  ) {
    return {
      response: `${baseResponse} Ready=${ready}. Workers=${runtime.workerCount}. Pending targets=${runtime.targets.pending}.`,
      ready,
      runtime,
      database: state.database,
    };
  }

  if (normalizedPrompt.includes("worker")) {
    return {
      response: `Workers=${runtime.workerCount}. Pending=${runtime.targets.pending}. Active=${runtime.targets.active}. Completed=${runtime.targets.completed}. Failed=${runtime.targets.failed}.`,
      ready,
      runtime,
    };
  }

  if (normalizedPrompt.includes("target")) {
    return {
      response: `Targets loaded=${runtime.targets.total}. Pending=${runtime.targets.pending}. Default target preload=${runtime.loadDefaultTargets ? "on" : "off"}.`,
      ready,
      runtime,
      targets: state.targets,
    };
  }

  if (normalizedPrompt.includes("log")) {
    return {
      response: `Returning the latest ${Math.min(state.logs.length, 10)} local log entries.`,
      ready,
      runtime,
      logs: state.logs.slice(-10),
    };
  }

  return {
    response: `${baseResponse} Available local commands: status, workers, targets, logs.`,
    ready,
    runtime,
  };
}

const state = {
  targets: [],
  logs: [],
  runtime: {
    mode: runtimeConfig.mode,
    stealthMode: runtimeConfig.stealthMode,
    loadDefaultTargets: runtimeConfig.loadDefaultTargets,
    allowStartupNetworkActions: runtimeConfig.allowStartupNetworkActions,
  },
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
  paypal: {
    accessTokenExpiresAt: null,
    accessTokenPresent: false,
    apiBaseUrl: paypalSandboxConfig.apiBaseUrl,
    authMode: paypalSandboxConfig.credentialsConfigured ? "oauth2-client-credentials" : "disabled",
    configured: paypalSandboxConfig.configured,
    credentialsConfigured: paypalSandboxConfig.credentialsConfigured,
    environment: paypalSandboxConfig.environment,
    lastAccessTokenAt: null,
    lastAuthStatus: null,
    lastError: paypalSandboxConfig.credentialsConfigured
      ? paypalSandboxConfig.webhookConfigured
        ? null
        : "PAYPAL_SANDBOX_WEBHOOK_ID must be configured for PayPal webhook verification"
      : "PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET must be configured",
    lastResourceId: null,
    lastResourceStatus: null,
    lastTransmissionId: null,
    lastUpdated: null,
    lastWebhookError: null,
    lastWebhookEventId: null,
    lastWebhookEventType: null,
    lastWebhookReceivedAt: null,
    lastWebhookVerificationError: null,
    lastWebhookVerificationStatus: null,
    persistedCount: 0,
    publicUrl: getHarvesterPublicUrl(),
    webhookIdPresent: Boolean(paypalSandboxConfig.webhookId),
    webhookUrl: getPayPalSandboxWebhookUrl(),
  },
  stripe: {
    secretPresent: Boolean(stripeConfig.envSecretKey),
    secretConfigured: stripeConfig.configured,
    authMode: stripeConfig.configured ? "bearer" : "disabled",
    apiBaseUrl: stripeConfig.apiBaseUrl,
    healthCheckPath: stripeConfig.healthCheckPath,
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
    lastAmountMinor: null,
    lastAmountDisplay: null,
    lastCustomerEmail: null,
    lastCurrency: null,
    lastEventId: null,
    lastEventType: null,
    lastGrantedScope: null,
    lastMerchantOrderReference: null,
    lastMerchantReference: null,
    lastOrderId: null,
    lastPaymentId: null,
    lastPaymentStatus: null,
    lastPersistedAt: null,
    lastRefreshAt: null,
    lastRefreshStatus: null,
    lastSettlementAmountMinor: null,
    lastSettlementAmountDisplay: null,
    lastSettlementCurrency: null,
    lastSettlementStatus: null,
    lastSignerStatus: null,
    lastTokenType: null,
    lastUpdated: null,
    lastWebhookError: null,
    lastWebhookId: null,
    lastWebhookReceivedAt: null,
    merchantWebhookUrl: getRevolutMerchantWebhookUrl(),
    persistedCount: 0,
    refreshTokenPresent: Boolean(resolveRuntimeRefreshToken()),
    revolutBaseUrl: revolutConfig.revolutBaseUrl,
    rotatedRefreshTokenAt: null,
    signerBaseUrl: revolutConfig.signerBaseUrl,
    signerConfigured: revolutConfig.signerConfigured,
    signerPath: revolutConfig.signerPath,
    targetAssetsEur: REVOLUT_MERCHANT_TARGET_ASSETS_EUR,
  },
  revolutMerchant: {
    apiBaseUrl: revolutMerchantConfig.apiBaseUrl,
    apiKeyPresent: Boolean(revolutMerchantConfig.apiKey),
    apiVersion: revolutMerchantConfig.apiVersion,
    configured: revolutMerchantConfig.configured,
    createOrderPath: revolutMerchantConfig.createOrderPath,
    lastCheckoutUrl: null,
    lastCreateRequestPath: null,
    lastCreateRequestUrl: null,
    lastCreatedAt: null,
    lastError: revolutMerchantConfig.configured
      ? null
      : "Revolut Merchant API key must be configured via REVOLUT_MERCHANT_API_KEY or REVOLUT_API_SECRET",
    lastOrderId: null,
    lastOrderState: null,
    lastPaymentStatus: null,
    lastPersisted: null,
    lastPersistenceError: null,
    lastStatusRequestPath: null,
    lastStatusRequestUrl: null,
    lastUpdated: null,
  },
  revolutBusinessTransfers: {
    airtableApiBaseUrl: airtableTransferConfig.apiBaseUrl,
    airtableTokenPresent: Boolean(airtableTransferConfig.apiKey),
    airtableConfigured: airtableTransferConfig.airtableConfigured,
    configured: airtableTransferConfig.configured && databaseConfig.configured,
    configurationError: null,
    databaseConfigured: databaseConfig.configured,
    discoveredAccountsCount: 0,
    discoveredAccountsPreview: [],
    draftOnly: !revolutBusinessTransferExecutionConfig.enabled,
    defaultCounterpartyPresent: Boolean(airtableTransferConfig.defaultCounterpartyId),
    defaultReceiverAccountPresent: Boolean(airtableTransferConfig.defaultReceiverAccountId),
    executionEnabled: revolutBusinessTransferExecutionConfig.enabled,
    executionPolicy: "explicit-opt-in",
    lastError: !databaseConfig.configured
      ? "DATABASE_* env vars must be configured for the persisted Revolut Business transfer queue"
      : airtableTransferConfig.airtableConfigured
        ? airtableTransferConfig.draftDefaultsConfigured
          ? null
          : getRevolutBusinessSourceAccountDiscoveryMode()
            ? null
            : getRevolutBusinessSourceAccountDiscoveryUnavailableMessage()
        : "AIRTABLE_* env vars must be configured to read the Markaðshlutafélagastýring view",
    lastDiscoveryAt: null,
    lastDiscoveryAttemptAt: null,
    lastDiscoveryError: null,
    lastDiscoveryRequestUrl: null,
    lastDiscoveryStatus: airtableTransferConfig.sourceAccountId
      ? "configured-via-env"
      : getRevolutBusinessSourceAccountDiscoveryMode()
        ? "pending"
        : "unavailable",
    lastDiscoveryTrigger: airtableTransferConfig.sourceAccountId ? "env" : null,
    lastExecutedCount: 0,
    lastExecutionAt: null,
    lastExecutionMode: null,
    lastPreparedAt: null,
    lastPreparedCount: 0,
    lastPreparedPreview: [],
    lastSkippedCount: 0,
    lastSourceRecordCount: 0,
    lastTransferId: null,
    lastTransferState: null,
    lastUpdated: null,
    optInField: revolutBusinessTransferExecutionConfig.optInField,
    persistedCount: 0,
    preparedCount: 0,
    processingCount: 0,
    completedCount: 0,
    failedCount: 0,
    blockedCount: 0,
    queueTable: REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE,
    revolutBusinessConfigured: revolutConfig.configured,
    revolutMerchantFallbackConfigured: revolutMerchantConfig.configured,
    sourceAccountId: airtableTransferConfig.sourceAccountId || null,
    sourceAccountIdPresent: Boolean(airtableTransferConfig.sourceAccountId),
    sourceAccountIdSource: airtableTransferConfig.sourceAccountId ? "env" : null,
    sourceAccountSelectionReason: airtableTransferConfig.sourceAccountId
      ? "Configured via env"
      : null,
    tableIdOrName: airtableTransferConfig.tableIdOrName || null,
    view: airtableTransferConfig.view,
  },
  empire: {
    assetCount: empireConfig.assets.length,
    cacheTtlMs: empireConfig.marketCacheTtlMs,
    lastError: null,
    lastUpdated: null,
    paypalRecoveryApr: empireConfig.paypalRecoveryApr,
    paypalRecoveryTargetDate: empireConfig.paypalRecoveryTargetDate,
    source: EMPIRE_MARKET_SOURCE,
  },
  database: {
    configured: databaseConfig.configured,
    connected: false,
    persistenceReady: false,
    connectionLabel: databaseConfig.connectionLabel,
    lastError: databaseConfig.configured ? null : "DATABASE_* env vars not configured",
    lastCheckedAt: null,
    sslMode: databaseConfig.sslMode,
    sslRootCertConfigured: databaseConfig.sslRootCertConfigured,
    tlsVerification: databaseConfig.tlsVerification,
  },
  stats: {
    workers: CONFIG.workers,
    active: 0,
    completed: 0,
    failed: 0,
  },
  workers: [],
};

syncRevolutBusinessTransferState();

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
        data = text.slice(0, 200); // First 200 chars
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
  log("info", `Mode: ${runtimeConfig.mode}`);
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
    paypalSandboxConfig.configured ? "success" : "warning",
    paypalSandboxConfig.configured
      ? `🅿️ PayPal Sandbox OAuth + webhook verification enabled via ${paypalSandboxConfig.apiBaseUrl}`
      : paypalSandboxConfig.credentialsConfigured
        ? "⚠️ PayPal Sandbox credentials detected, but PAYPAL_SANDBOX_WEBHOOK_ID is missing"
        : "⚠️ PayPal Sandbox credentials missing; /api/paypal/* and /api/webhooks/paypal-sandbox return 503 until configured",
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
    revolutBusinessTransferExecutionConfig.enabled ? "warning" : "info",
    revolutBusinessTransferExecutionConfig.enabled
      ? "🏦 Revolut Business /pay execution is enabled; POST /api/revolut/business-transfers/execute still requires confirmExecution=true"
      : "🏦 Revolut Business /pay execution is disabled by default; set REVOLUT_TRANSFER_EXECUTION_ENABLED=true to allow explicit execution",
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
      ? `🗄️ PostgreSQL target configured: ${databaseConfig.connectionLabel} (TLS ${databaseConfig.tlsVerification})`
      : "⚠️ DATABASE_* env vars missing; webhook receipts stay memory-only",
  );

  if (databaseConfig.configured) {
    await initializeDatabase();
  }

  if (stripeConfig.configured && runtimeConfig.allowStartupNetworkActions) {
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
  } else if (stripeConfig.configured) {
    log("info", "💳 Stripe startup health check skipped in stealth mode");
  }

  // Load targets
  state.targets = runtimeConfig.loadDefaultTargets ? [...DEFAULT_TARGETS] : [];
  log(
    "info",
    runtimeConfig.loadDefaultTargets
      ? `Loaded ${state.targets.length} default targets`
      : "Stealth mode: default targets not preloaded",
  );

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

app.post("/api/webhooks/paypal-sandbox", async (req, res) => {
  const publicUrl = getHarvesterPublicUrl(req);
  const webhookUrl = getPayPalSandboxWebhookUrl(req);

  if (!paypalSandboxConfig.credentialsConfigured) {
    return res.status(503).json({
      error: "PayPal Sandbox client credentials are not configured",
      publicUrl,
      webhookUrl,
    });
  }

  if (!paypalSandboxConfig.webhookConfigured) {
    return res.status(503).json({
      error: "PAYPAL_SANDBOX_WEBHOOK_ID is not configured",
      publicUrl,
      webhookUrl,
    });
  }

  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({
      error: "PayPal webhook payload must be a JSON object",
      publicUrl,
      webhookUrl,
    });
  }

  const receivedAt = new Date().toISOString();
  let verificationStatus = null;

  try {
    ({ verificationStatus } = await verifyPayPalSandboxWebhook(req));
  } catch (error) {
    state.paypal.lastWebhookError = error.message;
    state.paypal.lastWebhookVerificationError = error.message;
    state.paypal.lastUpdated = receivedAt;
    state.paypal.publicUrl = publicUrl || state.paypal.publicUrl;
    state.paypal.webhookUrl = webhookUrl || state.paypal.webhookUrl;
    log("warning", `🅿️ PayPal Sandbox webhook rejected: ${error.message}`);

    return res.status(error.message.includes("verification returned") ? 401 : 400).json({
      detail: error.message,
      error: "PayPal sandbox webhook verification failed",
      publicUrl,
      webhookUrl,
    });
  }

  const summary = summarizePayPalSandboxWebhook(req, verificationStatus);

  try {
    await ensureDatabaseReady(`PayPal sandbox event ${summary.eventType}`);
    await persistQueuedPayPalSandboxWebhookEvent(summary, req.body);
    const persistedCount = await refreshPayPalWebhookEventCount();

    state.paypal.lastError = null;
    state.paypal.lastResourceId = summary.resourceId;
    state.paypal.lastResourceStatus = summary.resourceStatus;
    state.paypal.lastTransmissionId = summary.transmissionId;
    state.paypal.lastUpdated = receivedAt;
    state.paypal.lastWebhookError = null;
    state.paypal.lastWebhookEventId = summary.eventId;
    state.paypal.lastWebhookEventType = summary.eventType;
    state.paypal.lastWebhookReceivedAt = receivedAt;
    state.paypal.lastWebhookVerificationError = null;
    state.paypal.lastWebhookVerificationStatus = verificationStatus;
    state.paypal.publicUrl = summary.publicUrl || state.paypal.publicUrl;
    state.paypal.webhookUrl = summary.webhookUrl || state.paypal.webhookUrl;

    log(
      "success",
      `🅿️ PayPal Sandbox webhook persisted directly to alphabet_paypal_webhook_events: ${summary.eventType} (${summary.eventId})`,
    );

    return res.status(202).json({
      eventId: summary.eventId,
      eventType: summary.eventType,
      persisted: true,
      persistedCount,
      publicUrl: summary.publicUrl,
      receivedAt,
      success: true,
      verificationStatus,
      webhookUrl: summary.webhookUrl,
    });
  } catch (error) {
    state.paypal.lastWebhookError = error.message;
    state.paypal.lastUpdated = receivedAt;
    log("error", `🅿️ PayPal Sandbox webhook persistence failed: ${error.message}`);

    return res.status(503).json({
      detail: error.message,
      error: "PayPal sandbox persistence unavailable",
      publicUrl,
      verificationStatus,
      webhookUrl,
    });
  }
});

app.post("/api/webhooks/revolut-merchant", async (req, res) => {
  const alphabetSource = normalizeAlphabetSource(req);

  if (!hasRevolutMerchantSignal(req, alphabetSource)) {
    return res.status(202).json({
      success: true,
      ignored: true,
      persisted: false,
      publicUrl: getHarvesterPublicUrl(req),
      receivedSource: alphabetSource || null,
      webhookUrl: getRevolutMerchantWebhookUrl(req),
    });
  }

  return handleRevolutMerchantWebhookRequest(req, res);
});

async function handleRevolutMerchantWebhookRequest(req, res) {
  const alphabetSource = normalizeAlphabetSource(req);
  const summary = summarizeRevolutMerchantEvent(req, alphabetSource);
  const receivedAt = new Date().toISOString();

  try {
    await ensureDatabaseReady(`Revolut merchant event ${summary.eventType}`);
    await persistQueuedRevolutMerchantEvent(summary, req.body);
    const persistedCount = await refreshRevolutMerchantEventCount();

    state.revolut.lastEventId = summary.eventId;
    state.revolut.lastEventType = summary.eventType;
    state.revolut.lastOrderId = summary.orderId;
    state.revolut.lastPaymentId = summary.paymentId;
    state.revolut.lastMerchantOrderReference = summary.merchantOrderReference;
    state.revolut.lastMerchantReference = summary.merchantReference;
    state.revolut.lastPaymentStatus = summary.paymentStatus;
    state.revolut.lastAmountMinor = summary.amountMinor;
    state.revolut.lastAmountDisplay = summary.amountDisplay;
    state.revolut.lastCustomerEmail = summary.customerEmail;
    state.revolut.lastCurrency = summary.currency;
    state.revolut.lastSettlementAmountMinor = summary.settlementAmountMinor;
    state.revolut.lastSettlementAmountDisplay = summary.settlementAmountDisplay;
    state.revolut.lastSettlementCurrency = summary.settlementCurrency;
    state.revolut.lastSettlementStatus = summary.settlementStatus;
    state.revolut.lastWebhookError = null;
    state.revolut.lastWebhookId = summary.webhookId;
    state.revolut.lastWebhookReceivedAt = receivedAt;
    state.revolut.lastPersistedAt = receivedAt;
    state.revolut.lastUpdated = receivedAt;
    state.revolut.merchantWebhookUrl = summary.webhookUrl || state.revolut.merchantWebhookUrl;

    log(
      "success",
      `💶 Revolut merchant event persisted directly to alphabet_revolut_merchant_events: ${summary.eventType} (${summary.eventId})`,
    );

    return res.status(202).json({
      success: true,
      persisted: true,
      eventId: summary.eventId,
      eventType: summary.eventType,
      persistedCount,
      publicUrl: summary.publicUrl,
      receivedAt,
      source: summary.source,
      table: "alphabet_revolut_merchant_events",
      targetAssetsEur: summary.targetAssetsEur,
      webhookUrl: summary.webhookUrl,
    });
  } catch (error) {
    state.revolut.lastWebhookError = error.message;
    state.revolut.lastUpdated = receivedAt;
    log("error", `💶 Revolut merchant persistence failed: ${error.message}`);

    return res.status(503).json({
      error: "Revolut merchant persistence unavailable",
      detail: error.message,
      publicUrl: summary.publicUrl,
      source: summary.source,
      table: "alphabet_revolut_merchant_events",
      webhookUrl: summary.webhookUrl,
    });
  }
}

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
app.get("/api/empire/market", async (req, res) => {
  try {
    const snapshot = await readEmpireDashboardSnapshot();

    return res.json({
      ...snapshot,
      database: {
        connected: state.database.connected,
        persistenceReady: state.database.persistenceReady,
        table: "alphabet_revolut_merchant_events",
        persistedCount: state.revolut.persistedCount,
      },
      empire: {
        ...state.empire,
      },
      paypalSandbox: {
        ...state.paypal,
      },
    });
  } catch (error) {
    state.empire.lastError = error.message;
    state.empire.lastUpdated = new Date().toISOString();

    return res.status(503).json({
      detail: error.message,
      error: "Empire market feed unavailable",
      empire: {
        ...state.empire,
      },
    });
  }
});
app.get("/api/paypal/health", async (req, res) => {
  if (!paypalSandboxConfig.credentialsConfigured) {
    return res.status(503).json({
      error: "PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET are not configured",
      paypal: {
        ...state.paypal,
        publicUrl: getHarvesterPublicUrl(req),
        webhookUrl: getPayPalSandboxWebhookUrl(req),
      },
    });
  }

  try {
    const paypal = await runPayPalSandboxHealthCheck();

    if (databasePool && state.database.connected) {
      await refreshPayPalWebhookEventCount();
    }

    return res.json({
      status: "ok",
      paypal,
      database: {
        connected: state.database.connected,
        persistenceReady: state.database.persistenceReady,
        table: "alphabet_paypal_webhook_events",
        persistedCount: state.paypal.persistedCount,
      },
    });
  } catch (error) {
    state.paypal.lastError = error.message;
    state.paypal.lastUpdated = new Date().toISOString();

    return res.status(503).json({
      status: "degraded",
      error: error.message,
      database: {
        connected: state.database.connected,
        persistenceReady: state.database.persistenceReady,
        table: "alphabet_paypal_webhook_events",
        persistedCount: state.paypal.persistedCount,
      },
    });
  }
});
app.get("/api/paypal/status", async (req, res) => {
  if (databasePool && state.database.connected) {
    try {
      await refreshPayPalWebhookEventCount();
    } catch (error) {
      state.paypal.lastError = error.message;
      state.paypal.lastUpdated = new Date().toISOString();
    }
  }

  res.json({
    ...state.paypal,
    publicUrl: getHarvesterPublicUrl(req),
    webhookUrl: getPayPalSandboxWebhookUrl(req),
    database: {
      connected: state.database.connected,
      persistenceReady: state.database.persistenceReady,
      table: "alphabet_paypal_webhook_events",
      persistedCount: state.paypal.persistedCount,
    },
  });
});
app.get("/api/revolut/status", async (req, res) => {
  if (databasePool && state.database.connected) {
    try {
      await refreshRevolutMerchantEventCount();
    } catch (error) {
      state.revolut.lastWebhookError = error.message;
      state.revolut.lastUpdated = new Date().toISOString();
    }
  }

  res.json({
    ...state.revolut,
    merchant: {
      ...state.revolutMerchant,
    },
    businessTransfers: {
      ...state.revolutBusinessTransfers,
    },
    database: {
      connected: state.database.connected,
      persistenceReady: state.database.persistenceReady,
      table: "alphabet_revolut_merchant_events",
      persistedCount: state.revolut.persistedCount,
    },
  });
});

app.get("/api/revolut/merchant/status", (req, res) => {
  res.json({
    ...state.revolutMerchant,
    publicUrl: getHarvesterPublicUrl(req),
    webhookUrl: getRevolutMerchantWebhookUrl(req),
  });
});

async function handleRevolutBusinessTransferStatusRequest(req, res) {
  if (
    !getResolvedRevolutBusinessTransferSourceAccountId() &&
    getRevolutBusinessSourceAccountDiscoveryMode()
  ) {
    await discoverRevolutBusinessSourceAccount({ reason: "status" });
  } else {
    syncRevolutBusinessTransferState();
  }

  if (databasePool && state.database.connected) {
    await refreshRevolutBusinessTransferQueueCounts();
  }

  return res.json({
    ...state.revolutBusinessTransfers,
    publicUrl: getHarvesterPublicUrl(req),
  });
}

app.get("/api/revolut/business-transfers/status", (req, res, next) => {
  void handleRevolutBusinessTransferStatusRequest(req, res).catch(next);
});

async function handleRevolutBusinessTransferQueueRequest(req, res) {
  if (!databasePool) {
    return res.status(503).json({
      error: "Revolut Business transfer queue requires a configured database",
      queueTable: REVOLUT_BUSINESS_TRANSFER_QUEUE_TABLE,
      transferQueue: state.revolutBusinessTransfers,
    });
  }

  await ensureDatabaseReady("Revolut Business transfer queue read");
  const limit = clampRevolutBusinessTransferQueueLimit(req.query.limit);
  const [entries, queue] = await Promise.all([
    readRevolutBusinessTransferQueue(limit),
    refreshRevolutBusinessTransferQueueCounts(),
  ]);

  return res.json({
    entries,
    queue,
    transferQueue: state.revolutBusinessTransfers,
  });
}

app.get("/api/revolut/business-transfers/queue", (req, res, next) => {
  void handleRevolutBusinessTransferQueueRequest(req, res).catch(next);
});

async function handleRevolutBusinessTransferPreparationRequest(req, res) {
  try {
    const maxRecords = req.body?.maxRecords ?? req.query?.maxRecords;
    const result = await prepareRevolutBusinessTransfersFromAirtable({ maxRecords });

    return res.json(result);
  } catch (error) {
    state.revolutBusinessTransfers.lastError = error.message;
    state.revolutBusinessTransfers.lastUpdated = new Date().toISOString();
    log("error", `🏦 Revolut Business transfer preparation failed: ${error.message}`);

    return res.status(503).json({
      error: "Revolut Business transfer preparation failed",
      detail: error.message,
      transferPreparation: state.revolutBusinessTransfers,
    });
  }
}

app.get("/api/revolut/business-transfers/prepare", (req, res, next) => {
  void handleRevolutBusinessTransferPreparationRequest(req, res).catch(next);
});

app.post("/api/revolut/business-transfers/prepare", (req, res, next) => {
  void handleRevolutBusinessTransferPreparationRequest(req, res).catch(next);
});

async function handleRevolutBusinessTransferExecutionRequest(req, res) {
  const confirmExecution = resolveRevolutBusinessTransferOptIn(
    req.body?.confirmExecution ?? req.query?.confirmExecution,
  );

  if (!revolutBusinessTransferExecutionConfig.enabled) {
    return res.status(409).json({
      error:
        "Revolut Business transfer execution is disabled; set REVOLUT_TRANSFER_EXECUTION_ENABLED=true to allow /pay execution",
      optInField: revolutBusinessTransferExecutionConfig.optInField,
      transferQueue: state.revolutBusinessTransfers,
    });
  }

  if (!confirmExecution) {
    return res.status(409).json({
      error: "Explicit opt-in is required before executing queued Revolut Business transfers",
      detail: `Pass ${revolutBusinessTransferExecutionConfig.optInField}=true in the request body or query string.`,
      optInField: revolutBusinessTransferExecutionConfig.optInField,
      transferQueue: state.revolutBusinessTransfers,
    });
  }

  try {
    const sourceRecordIds = normalizeRequestedSourceRecordIds(
      req.body?.sourceRecordIds ?? req.query?.sourceRecordIds,
    );
    const maxItems = req.body?.maxItems ?? req.query?.maxItems;
    const result = await executePreparedRevolutBusinessTransfers({
      maxItems,
      sourceRecordIds,
    });

    return res.json(result);
  } catch (error) {
    state.revolutBusinessTransfers.lastError = error.message;
    state.revolutBusinessTransfers.lastUpdated = new Date().toISOString();
    log("error", `🏦 Revolut Business execution failed: ${error.message}`);

    return res.status(503).json({
      error: "Revolut Business transfer execution failed",
      detail: error.message,
      transferQueue: state.revolutBusinessTransfers,
    });
  }
}

app.post("/api/revolut/business-transfers/execute", (req, res, next) => {
  void handleRevolutBusinessTransferExecutionRequest(req, res).catch(next);
});

async function handleRevolutMerchantOrderRequest(req, res) {
  try {
    const createResult = await createRevolutMerchantOrder(req.body || {});
    const payload = createResult.payload;
    const record = summarizeRevolutMerchantOrderRecord(payload, {
      checkoutUrl: typeof payload?.checkout_url === "string" ? payload.checkout_url : null,
      orderId: typeof payload?.id === "string" ? payload.id : null,
      orderState: typeof payload?.state === "string" ? payload.state : null,
    });
    const persistence = await persistRevolutMerchantOrderRecord(
      record,
      payload,
      `Revolut merchant order ${record.orderId}`,
    );

    state.revolutMerchant.lastError = persistence.persistenceError;
    state.revolutMerchant.lastPaymentStatus = record.paymentStatus;
    state.revolutMerchant.lastPersisted = persistence.persisted;
    state.revolutMerchant.lastPersistenceError = persistence.persistenceError;

    return res.status(201).json({
      success: true,
      localRequestPath: req.path,
      upstreamRequestPath: createResult.requestPath,
      upstreamRequestUrl: createResult.requestUrl,
      orderId: payload?.id || null,
      checkoutUrl: payload?.checkout_url || null,
      orderState: payload?.state || null,
      paymentStatus: record.paymentStatus,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      persisted: persistence.persisted,
      persistenceError: persistence.persistenceError,
      payload,
    });
  } catch (error) {
    state.revolutMerchant.lastError = error.message;
    state.revolutMerchant.lastUpdated = new Date().toISOString();
    log("error", `💶 Revolut merchant order creation failed: ${error.message}`);

    return res.status(503).json({
      error: "Revolut merchant order creation failed",
      detail: error.message,
      configured: state.revolutMerchant.configured,
      merchant: state.revolutMerchant,
    });
  }
}

app.post("/api/revolut/merchant/orders", (req, res, next) => {
  void handleRevolutMerchantOrderRequest(req, res).catch(next);
});

app.post("/api/revolut/merchant/create-order", (req, res, next) => {
  void handleRevolutMerchantOrderRequest(req, res).catch(next);
});

app.get("/api/revolut/merchant/orders", async (req, res) => {
  try {
    const limit = clampRevolutMerchantOrdersLimit(req.query.limit);

    if (databasePool) {
      await ensureDatabaseReady("Revolut merchant order history view");
    }

    const orders = await readRevolutMerchantOrders(limit);

    return res.json({
      database: {
        connected: state.database.connected,
        persistenceReady: state.database.persistenceReady,
        table: "alphabet_revolut_merchant_orders",
      },
      limit,
      orders,
    });
  } catch (error) {
    return res.status(503).json({
      error: "Revolut merchant order history fetch failed",
      detail: error.message,
      database: {
        connected: state.database.connected,
        persistenceReady: state.database.persistenceReady,
        table: "alphabet_revolut_merchant_orders",
      },
    });
  }
});

async function handleRevolutMerchantOrderStatusRequest(req, res) {
  try {
    const statusResult = await fetchRevolutMerchantOrder(req.params.id);
    const payload = statusResult.payload;
    const record = summarizeRevolutMerchantOrderRecord(payload, {
      orderId: normalizeTextValue(req.params.id),
    });
    const persistence = await persistRevolutMerchantOrderRecord(
      record,
      payload,
      `Revolut merchant order poll ${record.orderId}`,
    );

    state.revolutMerchant.lastCheckoutUrl =
      record.checkoutUrl || state.revolutMerchant.lastCheckoutUrl;
    state.revolutMerchant.lastCreatedAt = record.createdAt || state.revolutMerchant.lastCreatedAt;
    state.revolutMerchant.lastError = persistence.persistenceError;
    state.revolutMerchant.lastOrderId = record.orderId;
    state.revolutMerchant.lastOrderState = record.orderState;
    state.revolutMerchant.lastPaymentStatus = record.paymentStatus;
    state.revolutMerchant.lastPersisted = persistence.persisted;
    state.revolutMerchant.lastPersistenceError = persistence.persistenceError;
    state.revolutMerchant.lastStatusRequestPath = statusResult.requestPath;
    state.revolutMerchant.lastStatusRequestUrl = statusResult.requestUrl;
    state.revolutMerchant.lastUpdated = record.updatedAt || new Date().toISOString();

    return res.json({
      success: true,
      source: REVOLUT_MERCHANT_ORDER_POLL_SOURCE,
      localRequestPath: req.path,
      upstreamRequestPath: statusResult.requestPath,
      upstreamRequestUrl: statusResult.requestUrl,
      orderId: record.orderId,
      orderState: record.orderState,
      paymentStatus: record.paymentStatus,
      paymentId: record.paymentId,
      merchantOrderReference: record.merchantOrderReference,
      merchantReference: record.merchantReference,
      amountMinor: record.amountMinor,
      amountValue: record.amountValue,
      amountDisplay: record.amountDisplay,
      currency: record.currency,
      checkoutUrl: record.checkoutUrl,
      customerEmail: record.customerEmail,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      persisted: persistence.persisted,
      persistenceError: persistence.persistenceError,
    });
  } catch (error) {
    state.revolutMerchant.lastError = error.message;
    state.revolutMerchant.lastUpdated = new Date().toISOString();
    log("error", `💶 Revolut merchant order status poll failed: ${error.message}`);

    return res
      .status(
        error.message.includes("must be configured") ||
          error.message.includes("order id is required")
          ? 503
          : 502,
      )
      .json({
        error: "Revolut merchant order status fetch failed",
        detail: error.message,
        configured: state.revolutMerchant.configured,
        merchant: state.revolutMerchant,
      });
  }
}

app.get("/api/revolut/merchant/orders/:id", (req, res, next) => {
  void handleRevolutMerchantOrderStatusRequest(req, res).catch(next);
});

app.get("/api/revolut/merchant-events", async (req, res) => {
  try {
    await ensureDatabaseReady("Revolut merchant executive view");
    const limit = clampRevolutMerchantEventsLimit(req.query.limit);
    const [events, rawSummary] = await Promise.all([
      readRevolutMerchantEvents(limit),
      readRevolutMerchantExecutiveSummary(),
    ]);
    const summary = resolveRevolutExecutiveSummary(rawSummary);

    return res.json({
      database: {
        connected: state.database.connected,
        persistenceReady: state.database.persistenceReady,
        table: "alphabet_revolut_merchant_events",
        persistedCount: state.revolut.persistedCount,
      },
      events,
      summary: {
        ...summary,
        latestAmountDisplay: events[0]?.amountDisplay || null,
        latestCustomerEmail: events[0]?.customerEmail || null,
        latestEventId: events[0]?.eventId || null,
        latestMerchantReference:
          events[0]?.merchantOrderReference || events[0]?.merchantReference || null,
        latestSettlementAmountDisplay: events[0]?.settlementAmountDisplay || null,
      },
    });
  } catch (error) {
    state.revolut.lastWebhookError = error.message;
    state.revolut.lastUpdated = new Date().toISOString();

    return res.status(503).json({
      error: "Revolut merchant executive view unavailable",
      detail: error.message,
      database: {
        connected: state.database.connected,
        persistenceReady: state.database.persistenceReady,
        table: "alphabet_revolut_merchant_events",
        persistedCount: state.revolut.persistedCount,
      },
    });
  }
});
app.get("/api/revolut/refresh-token", handleRevolutRefreshRequest);
app.post("/api/revolut/refresh-token", handleRevolutRefreshRequest);

app.post("/api/arni/ask", (req, res) => {
  const payload = typeof req.body === "string" ? { prompt: req.body } : req.body || {};
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";

  if (!prompt.trim()) {
    return res.status(400).json({ error: "prompt is required" });
  }

  return res.json(buildArniResponse(prompt));
});

// Health check
app.get("/api/health", (req, res) => {
  const healthy = !state.database.configured || state.database.connected;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptime: process.uptime(),
    runtime: buildRuntimeSnapshot(),
    database: state.database,
    stripe: {
      publicUrl: state.stripe.publicUrl,
      merchantBackfill: state.stripe.merchantBackfill,
      merchantWebhookUrl: state.stripe.merchantWebhookUrl,
      secretPresent: state.stripe.secretPresent,
      secretSource: state.stripe.secretSource,
      healthCheckPath: state.stripe.healthCheckPath,
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
      lastAmountMinor: state.revolut.lastAmountMinor,
      lastAmountDisplay: state.revolut.lastAmountDisplay,
      lastCustomerEmail: state.revolut.lastCustomerEmail,
      lastCurrency: state.revolut.lastCurrency,
      merchantWebhookUrl: state.revolut.merchantWebhookUrl,
      persistedCount: state.revolut.persistedCount,
      targetAssetsEur: state.revolut.targetAssetsEur,
      lastEventId: state.revolut.lastEventId,
      lastEventType: state.revolut.lastEventType,
      lastMerchantOrderReference: state.revolut.lastMerchantOrderReference,
      lastMerchantReference: state.revolut.lastMerchantReference,
      lastOrderId: state.revolut.lastOrderId,
      lastPaymentId: state.revolut.lastPaymentId,
      lastPaymentStatus: state.revolut.lastPaymentStatus,
      lastAssertionIssuedAt: state.revolut.lastAssertionIssuedAt,
      lastAssertionExpiresAt: state.revolut.lastAssertionExpiresAt,
      lastPersistedAt: state.revolut.lastPersistedAt,
      lastRefreshAt: state.revolut.lastRefreshAt,
      lastError: state.revolut.lastError,
      lastSettlementAmountMinor: state.revolut.lastSettlementAmountMinor,
      lastSettlementAmountDisplay: state.revolut.lastSettlementAmountDisplay,
      lastSettlementCurrency: state.revolut.lastSettlementCurrency,
      lastSettlementStatus: state.revolut.lastSettlementStatus,
      lastWebhookError: state.revolut.lastWebhookError,
      lastWebhookId: state.revolut.lastWebhookId,
      lastWebhookReceivedAt: state.revolut.lastWebhookReceivedAt,
      canonicalNote: state.revolut.canonicalNote,
    },
  });
});

app.get("/api/ready", (req, res) => {
  const ready = !state.database.configured || state.database.connected;

  return res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not-ready",
    ready,
    runtime: buildRuntimeSnapshot(),
    database: state.database,
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
  const limit = Number.parseInt(req.query.limit || "100", 10);
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
