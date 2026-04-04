import type {
  ComposioConnection,
  ComposioConnectionRecord,
  ComposioConnectionsResponse,
  ComposioIdentityConfidence,
  ComposioReconnectClaim,
  ComposioReconnectConfidence,
  ComposioToolkit,
  ComposioToolkitRecord,
  ComposioToolkitsResponse,
} from "@/lib/composio";
import {
  normalizeComposioToolkitName,
  normalizeComposioToolkitSlug,
} from "@/lib/composio-normalization";

export { normalizeComposioToolkitSlug } from "@/lib/composio-normalization";

export type NormalizedComposioConnection = ComposioConnection & {
  normalized_toolkit_slug: string;
  normalized_status: string;
  is_active: boolean;
  account_identity: string;
  account_identity_source: "gateway_stable_id" | "legacy_heuristic" | "connection_id";
  identity_confidence: ComposioIdentityConfidence;
  display_label: string;
  reconnect_claim: ComposioReconnectClaim;
  reconnect_confidence: ComposioReconnectConfidence;
  related_connection_ids: string[];
  is_same_account_reconnect: boolean;
};

export function normalizeComposioConnectionStatus(status: unknown): string {
  return typeof status === "string" && status.trim()
    ? status.trim().toUpperCase()
    : "UNKNOWN";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = readString(value);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeComposioToolkitRecord(
  toolkit: ComposioToolkitRecord,
): ComposioToolkit {
  const meta = asRecord(toolkit.meta);
  const rawSlug = pickString(toolkit.slug, toolkit.name) ?? "unknown";
  const normalizedSlug = normalizeComposioToolkitSlug(rawSlug);
  const metaToolsCount = typeof meta?.tools_count === "number" ? meta.tools_count : undefined;
  const toolsCount = typeof toolkit.tools_count === "number"
    ? toolkit.tools_count
    : typeof toolkit.toolsCount === "number"
      ? toolkit.toolsCount
      : metaToolsCount ?? 0;

  const directCats = asStringArray(toolkit.categories);
  const metaCats = asStringArray(meta?.categories);
  const categories = directCats.length > 0
    ? directCats
    : metaCats;

  return {
    slug: normalizedSlug,
    connect_slug: rawSlug,
    name: normalizeComposioToolkitName(
      pickString(toolkit.name, toolkit.slug),
      rawSlug,
    ),
    description: pickString(
      toolkit.description,
      toolkit.description_short,
      toolkit.summary,
      readString(meta?.description),
    ) ?? "",
    logo: pickString(
      toolkit.logo,
      toolkit.logo_url,
      toolkit.icon,
      toolkit.image,
      readString(meta?.logo),
    ) ?? null,
    categories,
    auth_schemes: asStringArray(toolkit.auth_schemes ?? toolkit.authSchemes),
    tools_count: toolsCount,
  };
}

export function extractComposioToolkits(
  response: ComposioToolkitsResponse,
): {
  items: ComposioToolkit[];
  categories: string[];
  cursor: string | null;
  total: number;
} {
  const items = (response.items ?? []).map(normalizeComposioToolkitRecord);
  const categories = response.categories?.length
    ? response.categories
    : Array.from(new Set(items.flatMap((toolkit) => toolkit.categories)));

  return {
    items,
    categories,
    cursor: response.cursor ?? response.next_cursor ?? response.nextCursor ?? null,
    total: typeof response.total === "number"
      ? response.total
      : typeof response.total_items === "number"
        ? response.total_items
        : items.length,
  };
}

export function extractComposioConnections(
  response: ComposioConnectionsResponse,
): ComposioConnection[] {
  const rawConnections = response.connections?.length
    ? response.connections
    : response.items ?? [];

  return rawConnections.map(normalizeComposioConnectionRecord);
}

function normalizeComposioConnectionRecord(
  connection: ComposioConnectionRecord,
): ComposioConnection {
  const id = pickString(connection.id, connection.connectionId) ?? "unknown-connection";
  const rawToolkitSlug = pickString(connection.toolkit_slug, connection.toolkit?.slug) ?? "unknown";
  const toolkitSlug = normalizeComposioToolkitSlug(rawToolkitSlug);
  const toolkitName = pickString(
    connection.toolkit_name,
    connection.toolkit?.name,
    rawToolkitSlug,
  );
  const accountLabel = pickString(connection.account_label, connection.account?.label);
  const accountName = pickString(connection.account_name, connection.account?.label, accountLabel);
  const accountEmail = pickString(connection.account_email, connection.account?.email);
  const externalAccountId = pickString(
    connection.external_account_id,
    connection.account?.rawIds?.externalAccountId,
    connection.account?.rawIds?.providerAccountId,
  );
  const accountStableId = pickString(
    connection.account_stable_id,
    connection.account?.stableId,
  );

  return {
    id,
    toolkit_slug: toolkitSlug,
    toolkit_name: normalizeComposioToolkitName(toolkitName, rawToolkitSlug),
    status: pickString(connection.status) ?? "UNKNOWN",
    created_at: pickString(connection.created_at, connection.createdAt) ?? "",
    updated_at: pickString(connection.updated_at, connection.updatedAt) ?? null,
    account_label: accountLabel ?? null,
    account_name: accountName ?? null,
    account_email: accountEmail ?? null,
    external_account_id: externalAccountId ?? null,
    account_stable_id: accountStableId ?? null,
    toolkit: {
      slug: toolkitSlug,
      name: normalizeComposioToolkitName(
        pickString(connection.toolkit?.name, toolkitName),
        rawToolkitSlug,
      ),
    },
    account: connection.account
      ? {
          ...connection.account,
          stableId: accountStableId ?? null,
          confidence: connection.account.confidence ?? undefined,
          label: accountLabel ?? null,
          email: accountEmail ?? null,
        }
      : undefined,
    reconnect: connection.reconnect
      ? {
          claim: connection.reconnect.claim ?? "unknown",
          confidence: connection.reconnect.confidence ?? "unknown",
          relatedConnectionIds: connection.reconnect.relatedConnectionIds ?? [],
        }
      : undefined,
  };
}

function buildComposioConnectionDisplayLabel(connection: ComposioConnection): string {
  const label = [
    connection.account_label,
    connection.account_name,
    connection.account_email,
  ].find((value) => typeof value === "string" && value.trim());

  if (label) {
    return label;
  }

  return `Connection ${connection.id.slice(-6)}`;
}

function buildComposioConnectionIdentity(connection: ComposioConnection): {
  value: string;
  source: "gateway_stable_id" | "legacy_heuristic" | "connection_id";
  confidence: ComposioIdentityConfidence;
} {
  const gatewayStableId = pickString(
    connection.account_stable_id,
    connection.account?.stableId,
  );
  if (gatewayStableId) {
    return {
      value: gatewayStableId,
      source: "gateway_stable_id",
      confidence: connection.account?.confidence ?? "high",
    };
  }

  const legacyIdentity = [
    connection.external_account_id,
    connection.account_email,
    connection.account_name,
    connection.account_label,
  ].find((value) => typeof value === "string" && value.trim());

  if (legacyIdentity) {
    return {
      value: `${normalizeComposioToolkitSlug(connection.toolkit_slug)}:${legacyIdentity.trim().toLowerCase()}`,
      source: "legacy_heuristic",
      confidence: connection.external_account_id ? "high" : "low",
    };
  }

  return {
    value: `${normalizeComposioToolkitSlug(connection.toolkit_slug)}:${connection.id}`,
    source: "connection_id",
    confidence: "unknown",
  };
}

export function normalizeComposioConnection(
  connection: ComposioConnection,
): NormalizedComposioConnection {
  const normalized_status = normalizeComposioConnectionStatus(connection.status);
  const identity = buildComposioConnectionIdentity(connection);
  const reconnect_claim = connection.reconnect?.claim ?? "unknown";
  const reconnect_confidence = connection.reconnect?.confidence ?? "unknown";
  const related_connection_ids = connection.reconnect?.relatedConnectionIds ?? [];

  return {
    ...connection,
    normalized_toolkit_slug: normalizeComposioToolkitSlug(connection.toolkit_slug),
    normalized_status,
    is_active: normalized_status === "ACTIVE",
    account_identity: identity.value,
    account_identity_source: identity.source,
    identity_confidence: identity.confidence,
    display_label: buildComposioConnectionDisplayLabel(connection),
    reconnect_claim,
    reconnect_confidence,
    related_connection_ids,
    is_same_account_reconnect:
      reconnect_claim === "same" && reconnect_confidence === "high",
  };
}

function parseComposioConnectionTime(connection: ComposioConnection): number {
  const timestamp = Date.parse(connection.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortComposioConnections(
  left: NormalizedComposioConnection,
  right: NormalizedComposioConnection,
): number {
  if (left.is_active !== right.is_active) {
    return left.is_active ? -1 : 1;
  }

  const timeDiff = parseComposioConnectionTime(right) - parseComposioConnectionTime(left);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  return left.display_label.localeCompare(right.display_label);
}

export function normalizeComposioConnections(
  connections: ComposioConnection[],
): NormalizedComposioConnection[] {
  return connections.map(normalizeComposioConnection).sort(sortComposioConnections);
}
