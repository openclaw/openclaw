import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";

export const DEFAULT_SHOPIFY_API_VERSION = "2026-04";
const DEFAULT_REASON = "correction";
const DEFAULT_REFERENCE_DOCUMENT_URI = "openclaw://shopify/sold";
const AVAILABLE_QUANTITY_NAME = "available";
const DEFAULT_OAUTH_TOKEN_TTL_MS = 50 * 60 * 1000;
const TOKEN_EXPIRY_BUFFER_MS = 5_000;
const TOKEN_PATH = path.join(process.env.HOME || ".", ".openclaw", "shopify_tokens.json");

type ShopifyAuthMode = "token" | "oauth";

type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

type OAuthTokenCacheEntry = {
  token: string;
  expiresAt: number;
};

const oauthTokenCache = new Map<string, OAuthTokenCacheEntry>();

type PersistedTokenStore = Record<string, string>;

function readPersistedTokenStore(): PersistedTokenStore {
  if (!fs.existsSync(TOKEN_PATH)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(TOKEN_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const out: PersistedTokenStore = {};
    for (const [shop, token] of Object.entries(record)) {
      if (typeof token === "string" && token.trim().length > 0) {
        out[shop] = token;
      }
    }
    return out;
  } catch (err) {
    console.warn("Failed to read persisted Shopify token store:", err);
    return {};
  }
}

function persistTokenForShop(shop: string, token: string) {
  try {
    const store = readPersistedTokenStore();
    store[shop] = token;
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn("Failed to persist Shopify token:", err);
  }
}

export const ShopifyHealthcheckSchema = Type.Object({}, { additionalProperties: false });

export const ShopifyVariantSearchSchema = Type.Object(
  {
    sku: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    barcode: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);

export const ShopifyInventoryPreviewSchema = Type.Object(
  {
    variantId: Type.String({ minLength: 1 }),
    delta: Type.Number(),
    userId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false },
);

export const ShopifyInventoryApplySchema = Type.Object(
  {
    variantId: Type.String({ minLength: 1 }),
    delta: Type.Number(),
    expectedQuantity: Type.Number(),
    idempotencyKey: Type.String({ minLength: 1 }),
    referenceDocumentUri: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    userId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false },
);

export const ShopifyStageDropSchema = Type.Object(
  {
    dropName: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);

export type ShopifyHealthcheckParams = Static<typeof ShopifyHealthcheckSchema>;
export type ShopifyVariantSearchParams = Static<typeof ShopifyVariantSearchSchema>;
export type ShopifyInventoryPreviewParams = Static<typeof ShopifyInventoryPreviewSchema>;
export type ShopifyInventoryApplyParams = Static<typeof ShopifyInventoryApplySchema>;
export type ShopifyStageDropParams = Static<typeof ShopifyStageDropSchema>;

export type ShopifyAuthConfig = {
  mode: ShopifyAuthMode;
  adminToken?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
};

export type ShopifyPluginConfig = {
  storeDomain: string;
  locationId: string;
  auth: ShopifyAuthConfig;
  apiVersion: string;
  defaultDryRun: boolean;
};

export type ShopifyVariantMatch = {
  variantId: string;
  inventoryItemId: string;
  title: string;
  displayName: string;
  sku: string | null;
  barcode: string | null;
  tracked: boolean;
  availableQty: number;
};

type QuantityNode = {
  name?: string | null;
  quantity?: number | string | null;
};

type InventoryLevelNode = {
  id?: string | null;
  quantities?: QuantityNode[] | null;
};

type InventoryItemNode = {
  id?: string | null;
  tracked?: boolean | null;
  inventoryLevel?: InventoryLevelNode | null;
};

type VariantNode = {
  id?: string | null;
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
  product?: { title?: string | null } | null;
  inventoryItem?: InventoryItemNode | null;
};

type GraphqlError = {
  message?: string | null;
};

type GraphqlEnvelope<TData> = {
  data?: TData;
  errors?: GraphqlError[] | null;
};

export type InventoryAdjustChangeInput = {
  inventoryItemId: string;
  locationId: string;
  delta: number;
  changeFromQuantity: number;
};

export type InventoryAdjustQuantitiesInput = {
  reason: string;
  name: string;
  referenceDocumentUri: string;
  changes: InventoryAdjustChangeInput[];
};

export type InventoryPreview = {
  variantId: string;
  displayName: string;
  inventoryItemId: string;
  locationId: string;
  before: number;
  delta: number;
  after: number;
  expectedQuantity: number;
  idempotencyKey: string;
  apiVersion: string;
};

export type InventoryPreviewResult =
  | {
      ok: true;
      defaultDryRun: boolean;
      summary: string;
      preview: InventoryPreview;
    }
  | {
      ok: false;
      code: string;
      message: string;
      [key: string]: unknown;
    };

export type InventoryApplyResult =
  | {
      ok: true;
      applied: true;
      variantId: string;
      displayName: string;
      inventoryItemId: string;
      locationId: string;
      before: number;
      after: number;
      appliedDelta: number;
      delta: number;
      expectedQuantity: number;
      idempotencyKey: string;
      apiVersion: string;
      referenceDocumentUri: string;
      reason: string;
      summary: string;
      userErrors: [];
      verifyWarning?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      [key: string]: unknown;
    };

type InventoryLogLine = {
  requestId: string;
  userId: string | null;
  variantId: string;
  sku: string | null;
  before: number | null;
  delta: number | null;
  after: number | null;
  idempotencyKey: string | null;
  stage: string;
};

const HEALTHCHECK_QUERY = `
  query ShopifyHealthcheck {
    shop {
      id
      name
      myshopifyDomain
    }
  }
`;

const VARIANT_SEARCH_QUERY = `
  query ShopifyVariantSearch($query: String!, $first: Int!, $locationId: ID!) {
    productVariants(first: $first, query: $query) {
      edges {
        node {
          id
          title
          sku
          barcode
          product {
            title
          }
          inventoryItem {
            id
            tracked
            inventoryLevel(locationId: $locationId) {
              id
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

const VARIANT_SNAPSHOT_QUERY = `
  query ShopifyVariantInventorySnapshot($variantId: ID!, $locationId: ID!) {
    productVariant(id: $variantId) {
      id
      title
      sku
      barcode
      product {
        title
      }
      inventoryItem {
        id
        tracked
        inventoryLevel(locationId: $locationId) {
          id
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }
  }
`;

export const INVENTORY_ADJUST_QUANTITIES_MUTATION = `
  mutation ShopifyInventoryAdjustQuantities(
    $input: InventoryAdjustQuantitiesInput!
    $idempotencyKey: String!
  ) @idempotent(key: $idempotencyKey) {
    inventoryAdjustQuantities(input: $input) {
      userErrors {
        field
        message
        code
      }
      inventoryAdjustmentGroup {
        createdAt
        reason
        referenceDocumentUri
        changes {
          name
          delta
          quantityAfterChange
        }
      }
    }
  }
`;

type VariantSearchData = {
  productVariants?: {
    edges?: Array<{
      node?: VariantNode | null;
    } | null> | null;
  } | null;
};

type VariantSnapshotData = {
  productVariant?: VariantNode | null;
};

type InventoryAdjustMutationData = {
  inventoryAdjustQuantities?: {
    userErrors?: Array<{
      field?: string[] | null;
      message?: string | null;
      code?: string | null;
    } | null> | null;
    inventoryAdjustmentGroup?: {
      changes?: Array<{
        name?: string | null;
        quantityAfterChange?: number | null;
      } | null> | null;
    } | null;
  } | null;
};

type OAuthAccessTokenResponse = {
  access_token?: string;
  expires_in?: number;
};

type VariantSnapshot = ShopifyVariantMatch;

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeStoreDomain(value: unknown): string | undefined {
  const raw = normalizeString(value);
  if (!raw) {
    return undefined;
  }
  const withoutProtocol = raw.replace(/^https?:\/\//i, "");
  const withoutTrailingSlash = withoutProtocol.replace(/\/+$/g, "");
  if (!withoutTrailingSlash || withoutTrailingSlash.includes("/")) {
    return undefined;
  }
  return withoutTrailingSlash.toLowerCase();
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? Number.NaN)) {
    return 10;
  }
  const rounded = Math.trunc(limit ?? 10);
  return Math.max(1, Math.min(50, rounded));
}

function getAvailableQuantity(quantities: QuantityNode[] | null | undefined): number {
  for (const quantity of quantities ?? []) {
    if (quantity?.name !== AVAILABLE_QUANTITY_NAME) {
      continue;
    }
    const value = normalizeNumber(quantity.quantity);
    if (value !== null) {
      return value;
    }
  }
  return 0;
}

function formatDisplayName(
  productTitle: string | undefined,
  variantTitle: string | undefined,
): string {
  const safeProduct = productTitle?.trim() || "Untitled Product";
  const safeVariant = variantTitle?.trim();
  if (!safeVariant || safeVariant.toLowerCase() === "default title") {
    return safeProduct;
  }
  return `${safeProduct} / ${safeVariant}`;
}

function toVariantMatch(node: VariantNode | null | undefined): VariantSnapshot | null {
  const variantId = normalizeString(node?.id);
  const inventoryItemId = normalizeString(node?.inventoryItem?.id);
  if (!variantId || !inventoryItemId) {
    return null;
  }

  const title = formatDisplayName(
    normalizeString(node?.product?.title),
    normalizeString(node?.title),
  );

  return {
    variantId,
    inventoryItemId,
    title,
    displayName: title,
    sku: normalizeString(node?.sku) ?? null,
    barcode: normalizeString(node?.barcode) ?? null,
    tracked: node?.inventoryItem?.tracked === true,
    availableQty: getAvailableQuantity(node?.inventoryItem?.inventoryLevel?.quantities),
  };
}

function formatNumberedMatches(matches: ShopifyVariantMatch[]): string[] {
  return matches.map((match, index) => {
    const skuLabel = match.sku ? `sku:${match.sku}` : "sku:n/a";
    return `${index + 1}. ${match.title} (${skuLabel}, variantId:${match.variantId})`;
  });
}

function asToolResponse(details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}

function assertString(value: unknown, field: string): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error(`Missing Shopify plugin config: ${field}`);
  }
  return normalized;
}

function tokenCacheKey(config: ShopifyPluginConfig): string {
  return `${config.storeDomain}|${config.auth.clientId ?? "token"}`;
}

function isTokenCacheFresh(entry: OAuthTokenCacheEntry | undefined): entry is OAuthTokenCacheEntry {
  if (!entry) {
    return false;
  }
  return entry.expiresAt - TOKEN_EXPIRY_BUFFER_MS > Date.now();
}

function logInventoryLine(
  logger: LoggerLike | undefined,
  level: "info" | "warn",
  line: InventoryLogLine,
) {
  const text = `[shopify.inventory] ${JSON.stringify(line)}`;
  if (level === "warn") {
    logger?.warn?.(text);
    return;
  }
  logger?.info?.(text);
}

export function resolveShopifyConfig(rawConfig: unknown): ShopifyPluginConfig {
  const config = typeof rawConfig === "object" && rawConfig !== null ? rawConfig : {};
  const asRecord = config as Record<string, unknown>;

  const storeDomain = normalizeStoreDomain(asRecord.storeDomain);
  const locationId = normalizeString(asRecord.locationId);
  const apiVersion = normalizeString(asRecord.apiVersion) ?? DEFAULT_SHOPIFY_API_VERSION;
  const defaultDryRun = typeof asRecord.defaultDryRun === "boolean" ? asRecord.defaultDryRun : true;

  const authInput =
    typeof asRecord.auth === "object" && asRecord.auth !== null
      ? (asRecord.auth as Record<string, unknown>)
      : {};

  const legacyAdminToken = normalizeString(asRecord.adminToken);
  const requestedMode = normalizeString(authInput.mode);
  let mode: ShopifyAuthMode | undefined;
  if (requestedMode === "token" || requestedMode === "oauth") {
    mode = requestedMode;
  } else if (legacyAdminToken) {
    // Backwards compatibility for previous top-level adminToken config.
    mode = "token";
  }

  const adminToken = normalizeString(authInput.adminToken) ?? legacyAdminToken;
  const clientId = normalizeString(authInput.clientId);
  const clientSecret = normalizeString(authInput.clientSecret);
  const accessToken = normalizeString(authInput.accessToken);
  const refreshToken = normalizeString(authInput.refreshToken);

  const missing: string[] = [];
  if (!storeDomain) {
    missing.push("storeDomain");
  }
  if (!locationId) {
    missing.push("locationId");
  }
  if (!mode) {
    missing.push("auth.mode");
  }

  if (mode === "token" && !adminToken) {
    missing.push("auth.adminToken");
  }
  if (mode === "oauth") {
    if (!clientId) {
      missing.push("auth.clientId");
    }
    if (!clientSecret) {
      missing.push("auth.clientSecret");
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing Shopify plugin config: ${missing.join(", ")}. Configure plugins.entries.shopify.config.* before calling Shopify tools.`,
    );
  }

  return {
    storeDomain: assertString(storeDomain, "storeDomain"),
    locationId: assertString(locationId, "locationId"),
    auth: {
      mode: mode as ShopifyAuthMode,
      adminToken,
      clientId,
      clientSecret,
      accessToken,
      refreshToken,
    },
    apiVersion,
    defaultDryRun,
  };
}

export async function getAccessToken(options: {
  config: ShopifyPluginConfig;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { config } = options;

  if (config.auth.mode === "token") {
    const token = normalizeString(config.auth.adminToken);
    if (!token) {
      throw new Error("Missing Shopify admin token for auth.mode=token.");
    }
    return token;
  }

  const cacheKey = tokenCacheKey(config);
  const cached = oauthTokenCache.get(cacheKey);
  if (isTokenCacheFresh(cached)) {
    return cached.token;
  }

  const configuredAccessToken = normalizeString(config.auth.accessToken);
  if (configuredAccessToken) {
    oauthTokenCache.set(cacheKey, {
      token: configuredAccessToken,
      expiresAt: Date.now() + DEFAULT_OAUTH_TOKEN_TTL_MS,
    });
    persistTokenForShop(config.storeDomain, configuredAccessToken);
    return configuredAccessToken;
  }

  const persistedStore = readPersistedTokenStore();
  const persistedToken = normalizeString(persistedStore[config.storeDomain]);
  if (persistedToken) {
    oauthTokenCache.set(cacheKey, {
      token: persistedToken,
      expiresAt: Date.now() + DEFAULT_OAUTH_TOKEN_TTL_MS,
    });
    return persistedToken;
  }

  const clientId = normalizeString(config.auth.clientId);
  const clientSecret = normalizeString(config.auth.clientSecret);
  if (!clientId || !clientSecret) {
    throw new Error("Missing OAuth credentials (clientId/clientSecret) for auth.mode=oauth.");
  }

  const oauthUrl = `https://${config.storeDomain}/admin/oauth/access_token`;
  const oauthResponse = await fetchImpl(oauthUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  if (!oauthResponse.ok) {
    const body = await safeReadBody(oauthResponse);
    throw new Error(
      `Shopify OAuth token request failed (${oauthResponse.status}): ${body.slice(0, 500)}`,
    );
  }

  const payload = (await oauthResponse.json()) as OAuthAccessTokenResponse;
  const token = normalizeString(payload.access_token);
  if (!token) {
    throw new Error("Shopify OAuth token response did not include access_token.");
  }

  const ttlSeconds =
    typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 3000;
  oauthTokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  persistTokenForShop(config.storeDomain, token);

  return token;
}

export async function shopifyGraphql<TData>(options: {
  config: ShopifyPluginConfig;
  query: string;
  variables?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<TData> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const accessToken = await getAccessToken({ config: options.config, fetchImpl });
  const url = `https://${options.config.storeDomain}/admin/api/${options.config.apiVersion}/graphql.json`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-access-token": accessToken,
    },
    body: JSON.stringify({ query: options.query, variables: options.variables ?? {} }),
  });

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`Shopify request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const parsed = (await response.json()) as GraphqlEnvelope<TData>;
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    const joined = parsed.errors
      .map((entry) => normalizeString(entry.message) ?? "Unknown GraphQL error")
      .join("; ");
    throw new Error(`Shopify GraphQL error: ${joined}`);
  }

  if (!parsed.data) {
    throw new Error("Shopify GraphQL response did not include data.");
  }

  return parsed.data;
}

export function buildVariantSearchQuery(params: {
  sku?: string | null;
  barcode?: string | null;
  text?: string | null;
}): string | null {
  const sku = normalizeString(params.sku);
  if (sku) {
    return `sku:${sku}`;
  }

  const barcode = normalizeString(params.barcode);
  if (barcode) {
    return `barcode:${barcode}`;
  }

  const text = normalizeString(params.text);
  if (text) {
    return text;
  }

  return null;
}

export function buildInventoryAdjustInput(params: {
  inventoryItemId: string;
  locationId: string;
  delta: number;
  before: number;
  reason?: string | undefined;
  referenceDocumentUri?: string | undefined;
}): InventoryAdjustQuantitiesInput {
  return {
    reason: normalizeString(params.reason) ?? DEFAULT_REASON,
    name: AVAILABLE_QUANTITY_NAME,
    referenceDocumentUri:
      normalizeString(params.referenceDocumentUri) ?? DEFAULT_REFERENCE_DOCUMENT_URI,
    changes: [
      {
        inventoryItemId: params.inventoryItemId,
        locationId: params.locationId,
        delta: params.delta,
        changeFromQuantity: params.before,
      },
    ],
  };
}

async function fetchVariantSnapshot(options: {
  config: ShopifyPluginConfig;
  fetchImpl?: typeof fetch;
  variantId: string;
}): Promise<VariantSnapshot | null> {
  const data = await shopifyGraphql<VariantSnapshotData>({
    config: options.config,
    fetchImpl: options.fetchImpl,
    query: VARIANT_SNAPSHOT_QUERY,
    variables: {
      variantId: options.variantId,
      locationId: options.config.locationId,
    },
  });

  return toVariantMatch(data.productVariant);
}

export function createShopifyService(options: {
  config: ShopifyPluginConfig;
  fetchImpl?: typeof fetch;
  randomUuid?: () => string;
  logger?: LoggerLike;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const randomUuidFn = options.randomUuid ?? randomUUID;
  const config = options.config;
  const logger = options.logger;

  return {
    async healthcheck() {
      const data = await shopifyGraphql<{
        shop?: {
          id?: string | null;
          name?: string | null;
          myshopifyDomain?: string | null;
        } | null;
      }>({
        config,
        fetchImpl,
        query: HEALTHCHECK_QUERY,
      });

      return {
        ok: true,
        storeDomain: config.storeDomain,
        apiVersion: config.apiVersion,
        locationId: config.locationId,
        defaultDryRun: config.defaultDryRun,
        shop: {
          id: normalizeString(data.shop?.id) ?? null,
          name: normalizeString(data.shop?.name) ?? null,
          myshopifyDomain: normalizeString(data.shop?.myshopifyDomain) ?? null,
        },
      };
    },

    async variantSearch(params: ShopifyVariantSearchParams) {
      const query = buildVariantSearchQuery(params);
      if (!query) {
        return {
          ok: false,
          code: "QUERY_REQUIRED",
          message: "Provide one of sku, barcode, or text to search product variants.",
        };
      }

      const limit = normalizeLimit(params.limit);
      const data = await shopifyGraphql<VariantSearchData>({
        config,
        fetchImpl,
        query: VARIANT_SEARCH_QUERY,
        variables: {
          query,
          first: limit,
          locationId: config.locationId,
        },
      });

      const matches: ShopifyVariantMatch[] = [];
      for (const edge of data.productVariants?.edges ?? []) {
        const parsed = toVariantMatch(edge?.node);
        if (parsed) {
          matches.push(parsed);
        }
      }

      if (matches.length === 0) {
        return {
          ok: false,
          code: "NO_VARIANTS_FOUND",
          query,
          message: "No variants matched that query. Try sku:<value> or barcode:<value>.",
        };
      }

      const isTextQuery = !normalizeString(params.sku) && !normalizeString(params.barcode);
      const ambiguous = isTextQuery && matches.length > 1;

      return {
        ok: true,
        query,
        limit,
        locationId: config.locationId,
        ambiguous,
        message: ambiguous
          ? "Multiple variants matched. Pick one variantId and re-run preview/apply."
          : undefined,
        numberedMatches: ambiguous ? formatNumberedMatches(matches) : undefined,
        matches,
      };
    },

    async inventoryPreview(params: ShopifyInventoryPreviewParams): Promise<InventoryPreviewResult> {
      const requestId = randomUuidFn();
      const userId = normalizeString(params.userId) ?? null;
      const variantId = normalizeString(params.variantId);
      if (!variantId) {
        return {
          ok: false,
          code: "VARIANT_ID_REQUIRED",
          message: "variantId is required.",
        };
      }

      const snapshot = await fetchVariantSnapshot({ config, fetchImpl, variantId });
      if (!snapshot) {
        return {
          ok: false,
          code: "VARIANT_NOT_FOUND",
          message: `Variant ${variantId} was not found.`,
        };
      }

      if (!snapshot.tracked) {
        return {
          ok: false,
          code: "INVENTORY_NOT_TRACKED",
          message: `Inventory is not tracked for ${snapshot.displayName}. No adjustment was prepared.`,
          variantId: snapshot.variantId,
          displayName: snapshot.displayName,
        };
      }

      const before = snapshot.availableQty;
      const delta = params.delta;
      const after = before + delta;
      if (after < 0) {
        return {
          ok: false,
          code: "NEGATIVE_INVENTORY_BLOCKED",
          message: `Adjustment blocked because available quantity would become negative (${before} + ${delta} = ${after}).`,
          variantId: snapshot.variantId,
          displayName: snapshot.displayName,
          before,
          delta,
          attemptedAfter: after,
        };
      }

      const idempotencyKey = randomUuidFn();
      const preview: InventoryPreview = {
        variantId: snapshot.variantId,
        displayName: snapshot.displayName,
        inventoryItemId: snapshot.inventoryItemId,
        locationId: config.locationId,
        before,
        delta,
        after,
        expectedQuantity: before,
        idempotencyKey,
        apiVersion: config.apiVersion,
      };

      logInventoryLine(logger, "info", {
        requestId,
        userId,
        variantId: snapshot.variantId,
        sku: snapshot.sku,
        before,
        delta,
        after,
        idempotencyKey,
        stage: "preview",
      });

      return {
        ok: true,
        defaultDryRun: config.defaultDryRun,
        summary: `${before} -> ${after}`,
        preview,
      };
    },

    async inventoryApply(params: ShopifyInventoryApplyParams): Promise<InventoryApplyResult> {
      const requestId = randomUuidFn();
      const userId = normalizeString(params.userId) ?? null;
      const variantId = normalizeString(params.variantId);
      if (!variantId) {
        return {
          ok: false,
          code: "VARIANT_ID_REQUIRED",
          message: "variantId is required.",
        };
      }

      const idempotencyKey = normalizeString(params.idempotencyKey);
      if (!idempotencyKey) {
        return {
          ok: false,
          code: "IDEMPOTENCY_KEY_REQUIRED",
          message: "idempotencyKey is required and must be non-empty.",
        };
      }

      const expectedQuantity = params.expectedQuantity;
      if (!Number.isFinite(expectedQuantity)) {
        return {
          ok: false,
          code: "EXPECTED_QUANTITY_REQUIRED",
          message: "expectedQuantity is required and must be a finite number.",
        };
      }

      const snapshot = await fetchVariantSnapshot({ config, fetchImpl, variantId });
      if (!snapshot) {
        return {
          ok: false,
          code: "VARIANT_NOT_FOUND",
          message: `Variant ${variantId} was not found.`,
        };
      }

      if (!snapshot.tracked) {
        return {
          ok: false,
          code: "INVENTORY_NOT_TRACKED",
          message: `Inventory is not tracked for ${snapshot.displayName}. No adjustment was applied.`,
          variantId: snapshot.variantId,
          displayName: snapshot.displayName,
        };
      }

      const before = snapshot.availableQty;
      if (before !== expectedQuantity) {
        logInventoryLine(logger, "warn", {
          requestId,
          userId,
          variantId: snapshot.variantId,
          sku: snapshot.sku,
          before,
          delta: params.delta,
          after: null,
          idempotencyKey,
          stage: "apply_blocked_expected_quantity_mismatch",
        });

        return {
          ok: false,
          code: "EXPECTED_QUANTITY_MISMATCH",
          message:
            `Inventory changed since preview. Expected ${expectedQuantity} but current quantity is ${before}. ` +
            "Run preview again before applying.",
          variantId: snapshot.variantId,
          displayName: snapshot.displayName,
          expectedQuantity,
          currentQuantity: before,
          idempotencyKey,
        };
      }

      const delta = params.delta;
      const tentativeAfter = expectedQuantity + delta;
      if (tentativeAfter < 0) {
        return {
          ok: false,
          code: "NEGATIVE_INVENTORY_BLOCKED",
          message: `Adjustment blocked because available quantity would become negative (${expectedQuantity} + ${delta} = ${tentativeAfter}).`,
          variantId: snapshot.variantId,
          displayName: snapshot.displayName,
          before,
          delta,
          attemptedAfter: tentativeAfter,
        };
      }

      const input = buildInventoryAdjustInput({
        inventoryItemId: snapshot.inventoryItemId,
        locationId: config.locationId,
        delta,
        before: expectedQuantity,
        reason: params.reason,
        referenceDocumentUri: params.referenceDocumentUri,
      });

      const data = await shopifyGraphql<InventoryAdjustMutationData>({
        config,
        fetchImpl,
        query: INVENTORY_ADJUST_QUANTITIES_MUTATION,
        variables: {
          input,
          idempotencyKey,
        },
      });

      const userErrors = (data.inventoryAdjustQuantities?.userErrors ?? [])
        .map((entry) => ({
          field: entry?.field ?? null,
          code: normalizeString(entry?.code) ?? null,
          message: normalizeString(entry?.message) ?? "Unknown Shopify user error",
        }))
        .filter((entry) => entry.message.length > 0);

      if (userErrors.length > 0) {
        return {
          ok: false,
          code: "SHOPIFY_USER_ERRORS",
          message: "Shopify rejected the inventory adjustment.",
          userErrors,
          variantId: snapshot.variantId,
          displayName: snapshot.displayName,
          before,
          delta,
          attemptedAfter: tentativeAfter,
          idempotencyKey,
        };
      }

      const verifySnapshot = await fetchVariantSnapshot({
        config,
        fetchImpl,
        variantId: snapshot.variantId,
      });

      if (!verifySnapshot) {
        return {
          ok: false,
          code: "VERIFY_SNAPSHOT_MISSING",
          message: "Inventory apply succeeded but verify readback failed to resolve the variant.",
          variantId: snapshot.variantId,
          idempotencyKey,
        };
      }

      const verifiedAfter = verifySnapshot.availableQty;
      const appliedDelta = verifiedAfter - before;
      const expectedAfter = expectedQuantity + delta;
      const mismatch = verifiedAfter !== expectedAfter;

      if (mismatch) {
        logInventoryLine(logger, "warn", {
          requestId,
          userId,
          variantId: snapshot.variantId,
          sku: snapshot.sku,
          before,
          delta,
          after: verifiedAfter,
          idempotencyKey,
          stage: "apply_verify_mismatch",
        });
      } else {
        logInventoryLine(logger, "info", {
          requestId,
          userId,
          variantId: snapshot.variantId,
          sku: snapshot.sku,
          before,
          delta,
          after: verifiedAfter,
          idempotencyKey,
          stage: "apply_verified",
        });
      }

      return {
        ok: true,
        applied: true,
        variantId: snapshot.variantId,
        displayName: snapshot.displayName,
        inventoryItemId: snapshot.inventoryItemId,
        locationId: config.locationId,
        before,
        after: verifiedAfter,
        appliedDelta,
        delta,
        expectedQuantity,
        idempotencyKey,
        apiVersion: config.apiVersion,
        referenceDocumentUri: input.referenceDocumentUri,
        reason: input.reason,
        summary: `${before} -> ${verifiedAfter}`,
        userErrors: [],
        ...(mismatch
          ? {
              verifyWarning: `Inventory verify mismatch: expected ${expectedAfter} but observed ${verifiedAfter}.`,
            }
          : {}),
      };
    },

    async stageDrop(params: ShopifyStageDropParams) {
      return {
        ok: true,
        stub: true,
        message: "stage drop scaffolding only; no publish or product mutation was performed.",
        requestedDropName: normalizeString(params.dropName) ?? null,
        note: normalizeString(params.note) ?? null,
        todos: [
          "Define SKU/source-of-truth selection for the staged drop payload.",
          "Add dry-run preview tool output for staged products and inventory deltas.",
          "Require explicit confirmation + optional tools allowlist before any publish mutations.",
        ],
      };
    },
  };
}

function createSafeExecute<TParams>(options: {
  toolName: string;
  run: (params: TParams) => Promise<unknown>;
}) {
  return async (_toolCallId: string, rawParams: unknown) => {
    try {
      return asToolResponse(await options.run(rawParams as TParams));
    } catch (error) {
      return asToolResponse({
        ok: false,
        tool: options.toolName,
        error: errorMessage(error),
      });
    }
  };
}

export function createShopifyTools(options: {
  api: OpenClawPluginApi;
  fetchImpl?: typeof fetch;
  randomUuid?: () => string;
}): {
  healthcheck: AnyAgentTool;
  variantSearch: AnyAgentTool;
  inventoryPreview: AnyAgentTool;
  inventoryApply: AnyAgentTool;
  stageDrop: AnyAgentTool;
} {
  const buildService = () =>
    createShopifyService({
      config: resolveShopifyConfig(options.api.pluginConfig),
      fetchImpl: options.fetchImpl,
      randomUuid: options.randomUuid,
      logger: options.api.logger,
    });

  const healthcheck: AnyAgentTool = {
    name: "shopify_healthcheck",
    label: "Shopify Healthcheck",
    description: "Verify Shopify Admin API connectivity and return store metadata.",
    parameters: ShopifyHealthcheckSchema,
    execute: createSafeExecute<ShopifyHealthcheckParams>({
      toolName: "shopify_healthcheck",
      run: async () => buildService().healthcheck(),
    }),
  };

  const variantSearch: AnyAgentTool = {
    name: "shopify_variant_search",
    label: "Shopify Variant Search",
    description:
      "Find variants by sku, barcode, or text and include tracked/available inventory at the configured location.",
    parameters: ShopifyVariantSearchSchema,
    execute: createSafeExecute<ShopifyVariantSearchParams>({
      toolName: "shopify_variant_search",
      run: async (params) => buildService().variantSearch(params),
    }),
  };

  const inventoryPreview: AnyAgentTool = {
    name: "shopify_inventory_preview",
    label: "Shopify Inventory Preview",
    description:
      "Dry-run inventory adjustment preview for a single variant at the configured location, including idempotency key and expected quantity.",
    parameters: ShopifyInventoryPreviewSchema,
    execute: createSafeExecute<ShopifyInventoryPreviewParams>({
      toolName: "shopify_inventory_preview",
      run: async (params) => buildService().inventoryPreview(params),
    }),
  };

  const inventoryApply: AnyAgentTool = {
    name: "shopify_inventory_apply",
    label: "Shopify Inventory Apply",
    description:
      "Apply inventory adjustment via inventoryAdjustQuantities using @idempotent key, expectedQuantity CAS, and post-mutation verification.",
    parameters: ShopifyInventoryApplySchema,
    execute: createSafeExecute<ShopifyInventoryApplyParams>({
      toolName: "shopify_inventory_apply",
      run: async (params) => buildService().inventoryApply(params),
    }),
  };

  const stageDrop: AnyAgentTool = {
    name: "shopify_stage_drop",
    label: "Shopify Stage Drop",
    description:
      "Stub-only staging helper for future drop workflow. Returns TODOs and performs no Shopify mutations.",
    parameters: ShopifyStageDropSchema,
    execute: createSafeExecute<ShopifyStageDropParams>({
      toolName: "shopify_stage_drop",
      run: async (params) => buildService().stageDrop(params),
    }),
  };

  return {
    healthcheck,
    variantSearch,
    inventoryPreview,
    inventoryApply,
    stageDrop,
  };
}
