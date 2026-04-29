import { fetchWithSsrFGuard, type MSTeamsConfig } from "../runtime-api.js";
import { GRAPH_ROOT } from "./attachments/shared.js";

const GRAPH_BETA = "https://graph.microsoft.com/beta";
import {
  createMSTeamsTokenProvider,
  loadMSTeamsSdkWithAuth,
  type MSTeamsTokenProvider,
} from "./sdk.js";
import { readAccessToken } from "./token-response.js";
import {
  resolveDelegatedAccessToken,
  resolveMSTeamsCredentials,
  type MSTeamsCredentials,
} from "./token.js";
import { buildUserAgent } from "./user-agent.js";

export type GraphUser = {
  id?: string;
  displayName?: string;
  userPrincipalName?: string;
  mail?: string;
};

export type GraphGroup = {
  id?: string;
  displayName?: string;
};

export type GraphChannel = {
  id?: string;
  displayName?: string;
};

export type GraphResponse<T> = { value?: T[] };

type GraphTokenProviderCacheEntry = {
  key: string;
  tokenProvider: MSTeamsTokenProvider;
};

let graphTokenProviderCache: GraphTokenProviderCacheEntry | undefined;

function buildGraphTokenProviderCacheKey(creds: MSTeamsCredentials): string {
  if (creds.type === "secret") {
    return JSON.stringify([
      creds.type,
      creds.appId,
      creds.appPassword,
      creds.tenantId,
      creds.graphTenantId ?? "",
    ]);
  }
  return JSON.stringify([
    creds.type,
    creds.appId,
    creds.tenantId,
    creds.graphTenantId ?? "",
    creds.certificatePath ?? "",
    creds.certificateThumbprint ?? "",
    Boolean(creds.useManagedIdentity),
    creds.managedIdentityClientId ?? "",
  ]);
}

async function resolveGraphTokenProvider(creds: MSTeamsCredentials): Promise<MSTeamsTokenProvider> {
  const key = buildGraphTokenProviderCacheKey(creds);
  if (graphTokenProviderCache?.key === key) {
    return graphTokenProviderCache.tokenProvider;
  }
  const { app } = await loadMSTeamsSdkWithAuth(creds);
  const tokenProvider = createMSTeamsTokenProvider(app);
  graphTokenProviderCache = { key, tokenProvider };
  return tokenProvider;
}

export function _resetGraphTokenProviderCacheForTest(): void {
  graphTokenProviderCache = undefined;
}

export function normalizeQuery(value?: string | null): string {
  return value?.trim() ?? "";
}

export function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

async function requestGraph(params: {
  token: string;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  root?: string;
  headers?: Record<string, string>;
  body?: unknown;
  errorPrefix?: string;
}): Promise<{ response: Response; release: () => Promise<void> }> {
  const hasBody = params.body !== undefined;
  const { response, release } = await fetchWithSsrFGuard({
    url: `${params.root ?? GRAPH_ROOT}${params.path}`,
    init: {
      method: params.method,
      headers: {
        "User-Agent": buildUserAgent(),
        Authorization: `Bearer ${params.token}`,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...params.headers,
      },
      body: hasBody ? JSON.stringify(params.body) : undefined,
    },
    auditContext: "msteams.graph",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    await release();
    throw new Error(
      `${params.errorPrefix ?? "Graph"} ${params.path} failed (${response.status}): ${text || "unknown error"}`,
    );
  }
  return { response, release };
}

async function readOptionalGraphJson<T>(res: Response): Promise<T> {
  // Use optional chaining to stay resilient to partial test mocks that do not
  // provide a status or Headers instance (they only shim `ok` + `json()`).
  if (res.status === 204 || res.headers?.get?.("content-length") === "0") {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export async function fetchGraphJson<T>(params: {
  token: string;
  path: string;
  headers?: Record<string, string>;
  /** HTTP method; defaults to "GET" */
  method?: string;
  /** Request body (serialized as JSON). Only used for non-GET methods. */
  body?: unknown;
}): Promise<T> {
  const { response, release } = await requestGraph({
    token: params.token,
    path: params.path,
    method: params.method as "GET" | "POST" | "DELETE" | undefined,
    body: params.body,
    headers: params.headers,
  });
  try {
    return await readOptionalGraphJson<T>(response);
  } finally {
    await release();
  }
}

/**
 * Fetch JSON from an absolute Graph API URL (for example @odata.nextLink
 * pagination URLs) without prepending GRAPH_ROOT.
 */
export async function fetchGraphAbsoluteUrl<T>(params: {
  token: string;
  url: string;
  headers?: Record<string, string>;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: {
      headers: {
        "User-Agent": buildUserAgent(),
        Authorization: `Bearer ${params.token}`,
        ...params.headers,
      },
    },
    auditContext: "msteams.graph.absolute",
  });
  try {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Graph ${params.url} failed (${response.status}): ${text || "unknown error"}`,
      );
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

/** Graph collection response with optional pagination link. */
export type GraphPagedResponse<T> = {
  value?: T[];
  "@odata.nextLink"?: string;
};

/** Result of a paginated Graph API fetch. */
export type PaginatedResult<T> = {
  items: T[];
  truncated: boolean;
  found?: T;
};

/**
 * Fetch all pages of a Graph API collection, following @odata.nextLink.
 * Optionally stop early when `findOne` matches an item.
 */
export async function fetchAllGraphPages<T>(params: {
  token: string;
  path: string;
  headers?: Record<string, string>;
  /** Max pages to fetch before stopping. Default: 50. */
  maxPages?: number;
  /** Stop pagination early when this predicate returns true. */
  findOne?: (item: T) => boolean;
}): Promise<PaginatedResult<T>> {
  const maxPages = params.maxPages ?? 50;
  const items: T[] = [];
  let nextPath: string | undefined = params.path;

  for (let page = 0; page < maxPages && nextPath; page++) {
    const res: GraphPagedResponse<T> = await fetchGraphJson<GraphPagedResponse<T>>({
      token: params.token,
      path: nextPath,
      headers: params.headers,
    });

    const pageItems = res.value ?? [];

    if (params.findOne) {
      const match = pageItems.find(params.findOne);
      if (match) {
        items.push(...pageItems);
        return { items, truncated: false, found: match };
      }
    }

    items.push(...pageItems);

    // @odata.nextLink is an absolute URL; strip the Graph root to get a relative path
    const rawNext: string | undefined = res["@odata.nextLink"];
    if (rawNext) {
      nextPath = rawNext
        .replace("https://graph.microsoft.com/v1.0", "")
        .replace("https://graph.microsoft.com/beta", "");
    } else {
      nextPath = undefined;
    }
  }

  return { items, truncated: Boolean(nextPath) };
}

export async function resolveGraphToken(
  cfg: unknown,
  options?: { preferDelegated?: boolean },
): Promise<string> {
  const msteamsCfg = (cfg as { channels?: { msteams?: MSTeamsConfig } })?.channels?.msteams;
  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    throw new Error("MS Teams credentials missing");
  }

  // Try delegated token if requested and configured
  if (options?.preferDelegated && msteamsCfg?.delegatedAuth?.enabled && creds.type === "secret") {
    const delegated = await resolveDelegatedAccessToken({
      tenantId: creds.tenantId,
      clientId: creds.appId,
      clientSecret: creds.appPassword,
    });
    if (delegated) {
      return delegated;
    }
    // Fall through to app-only token
  }

  // If graphTenantId is set (and differs from tenantId), use it for Graph token
  // acquisition so the bot app registration tenant and the M365 data tenant can differ.
  const graphCreds =
    creds.graphTenantId && creds.graphTenantId !== creds.tenantId
      ? { ...creds, tenantId: creds.graphTenantId }
      : creds;

  const tokenProvider = await resolveGraphTokenProvider(graphCreds);
  const graphTokenValue = await tokenProvider.getAccessToken("https://graph.microsoft.com");
  const accessToken = readAccessToken(graphTokenValue);
  if (!accessToken) {
    throw new Error("MS Teams graph token unavailable");
  }
  return accessToken;
}

export async function listTeamsByName(token: string, query: string): Promise<GraphGroup[]> {
  const escaped = escapeOData(query);
  const filter = `resourceProvisioningOptions/Any(x:x eq 'Team') and startsWith(displayName,'${escaped}')`;
  const path = `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName`;
  const { items } = await fetchAllGraphPages<GraphGroup>({ token, path, maxPages: 5 });
  return items;
}

export async function postGraphJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const { response, release } = await requestGraph({
    token: params.token,
    path: params.path,
    method: "POST",
    body: params.body,
    errorPrefix: "Graph POST",
  });
  try {
    return await readOptionalGraphJson<T>(response);
  } finally {
    await release();
  }
}

export async function postGraphBetaJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const { response, release } = await requestGraph({
    token: params.token,
    path: params.path,
    method: "POST",
    root: GRAPH_BETA,
    body: params.body,
    errorPrefix: "Graph beta POST",
  });
  try {
    return await readOptionalGraphJson<T>(response);
  } finally {
    await release();
  }
}

export async function deleteGraphRequest(params: { token: string; path: string }): Promise<void> {
  const { release } = await requestGraph({
    token: params.token,
    path: params.path,
    method: "DELETE",
    errorPrefix: "Graph DELETE",
  });
  await release();
}

export async function patchGraphJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const { response, release } = await requestGraph({
    token: params.token,
    path: params.path,
    method: "PATCH",
    body: params.body,
    errorPrefix: "Graph PATCH",
  });
  try {
    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

export async function listChannelsForTeam(token: string, teamId: string): Promise<GraphChannel[]> {
  const path = `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`;
  const { items } = await fetchAllGraphPages<GraphChannel>({ token, path, maxPages: 10 });
  return items;
}
