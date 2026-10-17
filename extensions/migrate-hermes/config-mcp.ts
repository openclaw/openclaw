import { isStringArray } from "openclaw/plugin-sdk/collection-input-runtime";
import { createMigrationManualItem } from "openclaw/plugin-sdk/migration";
import { asPositiveFiniteNumber as readPositiveNumber } from "openclaw/plugin-sdk/number-runtime";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import {
  asBoolean,
  asOptionalRecord,
  isRecord,
  normalizeOptionalString,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMcpEnvReferences } from "./config-env.js";
import { sanitizeName } from "./helpers.js";

const MCP_RESOURCE_UTILITY_TOOLS = ["resources_list", "resources_read"] as const;
const MCP_PROMPT_UTILITY_TOOLS = ["prompts_list", "prompts_get"] as const;

function readPositiveNumeric(value: unknown): number | undefined {
  return readPositiveNumber(typeof value === "string" ? Number(value) : value);
}

function readToolFilterList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (!isStringArray(value)) {
    return undefined;
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function hasUnsupportedToolPattern(pattern: string): boolean {
  // Hermes uses fnmatch; OpenClaw supports only exact names and `*`.
  return pattern.includes("?") || pattern.includes("[");
}

function mapHermesClientCertificate(value: Record<string, unknown>): {
  clientCert?: string;
  clientKey?: string;
} {
  const cert = value.clientCert ?? value.client_cert;
  const key = normalizeOptionalString(value.clientKey) ?? normalizeOptionalString(value.client_key);
  if (Array.isArray(cert) && cert.length === 2) {
    const certPath = normalizeOptionalString(cert[0]);
    const keyPath = normalizeOptionalString(cert[1]);
    return certPath && keyPath ? { clientCert: certPath, clientKey: keyPath } : {};
  }
  const certPath = normalizeOptionalString(cert);
  return certPath && key ? { clientCert: certPath, clientKey: key } : {};
}

const MCP_CONNECTION_FIELDS = [
  "enabled",
  "command",
  "args",
  "cwd",
  "workingDirectory",
  "url",
  "connectionTimeoutMs",
  "requestTimeoutMs",
] as const;

function mapHermesMcpOauth(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const oauth = asOptionalRecord(value.oauth);
  if (!oauth) {
    return undefined;
  }
  const mapped: Record<string, unknown> = {};
  for (const key of ["authProfileId", "scope", "redirectUrl", "clientMetadataUrl"]) {
    const fieldValue = normalizeOptionalString(oauth[key]);
    if (fieldValue) {
      mapped[key] = fieldValue;
    }
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export function planHermesMcpServer(params: {
  name: string;
  raw: Record<string, unknown>;
  includeSecrets: boolean;
  env: Record<string, string>;
  source: string;
}): { server: Record<string, unknown>; sensitive: boolean; items: MigrationItem[] } {
  const { name, raw, includeSecrets, env } = params;
  let sensitive = raw.env !== undefined || raw.headers !== undefined;
  let unresolved = false;
  const resolvedFields: Record<string, unknown> = {};
  for (const key of [...MCP_CONNECTION_FIELDS, "env", "headers"]) {
    const sourceValue = raw[key];
    if (sourceValue === undefined) {
      continue;
    }
    const resolved = resolveMcpEnvReferences(sourceValue, env);
    const requiresConsent = key === "env" || key === "headers" || resolved.referenced;
    sensitive ||= requiresConsent;
    if (requiresConsent && !includeSecrets) {
      continue;
    }
    unresolved ||= resolved.unresolved;
    if (!resolved.unresolved) {
      resolvedFields[key] = resolved.value;
    }
  }
  const { env: resolvedEnv, headers: resolvedHeaders, ...next } = resolvedFields;
  const transport = normalizeOptionalString(raw.transport) ?? normalizeOptionalString(raw.type);
  if (transport === "http" || transport === "streamable-http") {
    next.transport = "streamable-http";
  } else if (transport === "sse" || transport === "stdio") {
    next.transport = transport;
  } else if (!transport && normalizeOptionalString(next.url)) {
    next.transport = "streamable-http";
  }
  // Canonical timeout fields are finite().positive(); drop non-positive or
  // overflowing source values instead of importing config that fails validation.
  for (const [key, seconds] of [
    ["connectionTimeoutMs", raw.connectTimeout ?? raw.connect_timeout],
    ["requestTimeoutMs", raw.timeout],
  ] as const) {
    if (
      next[key] === undefined &&
      typeof seconds === "number" &&
      seconds > 0 &&
      Number.isFinite(seconds * 1_000)
    ) {
      next[key] = seconds * 1_000;
    }
  }
  next.supportsParallelToolCalls = asBoolean(
    raw.supportsParallelToolCalls ?? raw.supports_parallel_tool_calls,
  );
  next.sslVerify = asBoolean(raw.sslVerify ?? raw.ssl_verify);
  const auth = normalizeOptionalString(raw.auth);
  next.auth = auth === "oauth" ? "oauth" : undefined;
  next.oauth = mapHermesMcpOauth(raw);
  const certificate = mapHermesClientCertificate(raw);
  Object.assign(next, certificate);
  const tools = asOptionalRecord(raw.tools);
  const include = tools ? readToolFilterList(tools.include) : undefined;
  const exclude = tools ? readToolFilterList(tools.exclude) : undefined;
  const resources = parseBooleanValue(tools?.resources);
  const prompts = parseBooleanValue(tools?.prompts);
  const direct = asOptionalRecord(raw.toolFilter) ?? asOptionalRecord(raw.tool_filter);
  if (direct) {
    const directInclude = readToolFilterList(direct.include);
    const directExclude = readToolFilterList(direct.exclude);
    next.toolFilter = directInclude?.length
      ? { include: directInclude }
      : directExclude?.length
        ? { exclude: directExclude }
        : undefined;
  } else if (tools) {
    if (include !== undefined) {
      const allowed = [
        ...include.filter((pattern) => !hasUnsupportedToolPattern(pattern)),
        ...(resources !== false ? MCP_RESOURCE_UTILITY_TOOLS : []),
        ...(prompts !== false ? MCP_PROMPT_UTILITY_TOOLS : []),
      ];
      // Hermes' empty include disables native tools; OpenClaw's is unrestricted.
      next.toolFilter = allowed.length > 0 ? { include: allowed } : { exclude: ["*"] };
    } else {
      const denied = [
        ...(exclude ?? []),
        ...(resources === false ? MCP_RESOURCE_UTILITY_TOOLS : []),
        ...(prompts === false ? MCP_PROMPT_UTILITY_TOOLS : []),
      ];
      next.toolFilter = denied.length > 0 ? { exclude: denied } : undefined;
    }
  }
  if (include === undefined && exclude?.some(hasUnsupportedToolPattern)) {
    // An untranslated exclusion would expose tools Hermes withheld.
    next.enabled = false;
  }
  next.env = resolvedEnv;
  next.headers = resolvedHeaders;
  const mapped = Object.fromEntries(
    Object.entries(next).filter(([, entry]) => entry !== undefined),
  );
  const safeName = sanitizeName(name);
  const items: MigrationItem[] = [];
  const add = (suffix: string, message: string, recommendation: string): void => {
    items.push(
      createMigrationManualItem({
        id: `manual:mcp-server-${suffix}:${safeName}`,
        source: params.source,
        message,
        recommendation,
      }),
    );
  };

  if (!includeSecrets && sensitive) {
    add(
      "secrets",
      `Hermes MCP server "${name}" has environment-backed values that were not imported without secret consent.`,
      "Re-run with --include-secrets or configure these values manually.",
    );
  }
  if (includeSecrets && unresolved) {
    add(
      "unresolved-secrets",
      `Hermes MCP server "${name}" references environment values that were not found in its .env file.`,
      "Define the missing values in OpenClaw's MCP server environment or headers manually.",
    );
  }

  const cert = raw.clientCert ?? raw.client_cert;
  const key = normalizeOptionalString(raw.clientKey) ?? normalizeOptionalString(raw.client_key);
  if (Array.isArray(cert) && cert.length === 3) {
    add(
      "client-cert-password",
      `Hermes MCP server "${name}" uses a password-protected client key, which OpenClaw cannot represent in MCP config.`,
      "Configure an unencrypted protected key path or an equivalent TLS proxy manually.",
    );
  } else if ((cert !== undefined || key !== undefined) && !certificate.clientCert) {
    add(
      "client-cert",
      `Hermes MCP server "${name}" uses a combined or invalid client-certificate shape that was not imported.`,
      "Configure separate OpenClaw clientCert and clientKey file paths manually.",
    );
  }
  if (typeof (raw.sslVerify ?? raw.ssl_verify) === "string") {
    add(
      "tls-ca",
      `Hermes MCP server "${name}" uses a CA bundle path for TLS verification, which OpenClaw MCP config cannot represent.`,
      "Install the CA in the host trust store or configure an equivalent TLS proxy manually.",
    );
  }

  if (transport && !["http", "streamable-http", "sse", "stdio"].includes(transport)) {
    add(
      "transport",
      `Hermes MCP server "${name}" uses unsupported transport "${transport}".`,
      "Configure an equivalent OpenClaw MCP transport manually.",
    );
  }

  if (auth && auth !== "oauth") {
    add(
      "auth",
      `Hermes MCP server "${name}" uses unsupported authentication mode "${auth}".`,
      "Configure an equivalent OpenClaw MCP authentication mode manually.",
    );
  }
  const oauth = asOptionalRecord(raw.oauth);
  if (auth === "oauth" || oauth) {
    add(
      "oauth-login",
      `Hermes MCP server "${name}" requires OAuth login in OpenClaw.`,
      `Run "openclaw mcp login ${name}" after migration.`,
    );
  }
  if (
    oauth &&
    Object.keys(oauth).some(
      (keyName) =>
        !["authProfileId", "scope", "redirectUrl", "clientMetadataUrl"].includes(keyName),
    )
  ) {
    add(
      "oauth-client",
      `Hermes MCP server "${name}" uses pre-registered OAuth client settings that were not copied into OpenClaw config.`,
      `Run "openclaw mcp login ${name}" and configure supported OAuth metadata manually.`,
    );
  }

  const activePatterns = include ?? exclude;
  if (activePatterns?.some(hasUnsupportedToolPattern)) {
    add(
      "tool-patterns",
      include === undefined
        ? `Hermes MCP server "${name}" was imported disabled because its tool exclusions use unsupported fnmatch patterns.`
        : `Hermes MCP server "${name}" has tool include patterns that were omitted because OpenClaw supports only exact names and "*".`,
      "Replace ? and bracket patterns with exact tool names or equivalent * patterns in mcp.servers toolFilter, then enable the server if disabled.",
    );
  }
  if (
    tools &&
    (Object.keys(tools).some(
      (keyName) => !["include", "exclude", "resources", "prompts"].includes(keyName),
    ) ||
      (tools.include !== undefined && !include) ||
      (tools.exclude !== undefined && !exclude) ||
      (tools.resources !== undefined && resources === undefined) ||
      (tools.prompts !== undefined && prompts === undefined))
  ) {
    add(
      "tool-policy",
      `Hermes MCP server "${name}" has a tool policy that cannot be translated exactly.`,
      "Review and configure mcp.servers toolFilter manually.",
    );
  }

  const lifecycle = isRecord(raw.lifecycle) ? raw.lifecycle : {};
  const unsupported = [
    ["preflight", raw.skip_preflight === true],
    ["sampling", isRecord(raw.sampling) && raw.sampling.enabled !== false],
    ["elicitation", isRecord(raw.elicitation) && raw.elicitation.enabled !== false],
    [
      "lifecycle",
      readPositiveNumeric(raw.idle_timeout_seconds ?? lifecycle.idle_timeout_seconds) !==
        undefined ||
        readPositiveNumeric(raw.max_lifetime_seconds ?? lifecycle.max_lifetime_seconds) !==
          undefined,
    ],
    ["keepalive", readPositiveNumeric(raw.keepalive_interval) !== undefined],
  ] as const;
  for (const [feature, configured] of unsupported) {
    if (configured) {
      add(
        feature,
        `Hermes MCP server "${name}" uses ${feature} behavior that OpenClaw MCP config does not expose.`,
        "Review the server requirement and configure an equivalent deployment or runtime policy manually.",
      );
    }
  }
  return {
    server:
      normalizeOptionalString(mapped.command) || normalizeOptionalString(mapped.url) ? mapped : {},
    sensitive: includeSecrets && sensitive,
    items,
  };
}
