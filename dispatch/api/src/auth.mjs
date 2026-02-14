import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getCommandEndpointPolicy,
  getDispatchToolPolicy,
} from "../../shared/authorization-policy.mjs";
import { HttpError, isUuid, lowerHeader, requireHeader } from "./http-utils.mjs";

const ACTOR_TYPES = new Set(["HUMAN", "AGENT", "SERVICE", "SYSTEM"]);
const ACTOR_ROLE_ALIASES = {
  assistant: "dispatcher",
  bot: "dispatcher",
};

const READ_ENDPOINT_TOOL_NAMES = Object.freeze({
  "/tickets/{ticketId}": "ticket.get",
  "/tickets/{ticketId}/timeline": "ticket.timeline",
  "/tickets/{ticketId}/evidence": "closeout.list_evidence",
  "/ux/dispatcher/cockpit": "dispatcher.cockpit",
  "/ux/technician/job-packet/{ticketId}": "tech.job_packet",
});

function buildReadEndpointPolicies() {
  const entries = Object.entries(READ_ENDPOINT_TOOL_NAMES).map(([endpoint, toolName]) => {
    const policy = getDispatchToolPolicy(toolName);
    if (!policy) {
      throw new Error(`Read endpoint policy cannot be built for missing tool '${toolName}'`);
    }
    return [
      endpoint,
      Object.freeze({
        endpoint,
        default_tool_name: policy.tool_name,
        allowed_tool_names: Object.freeze([policy.tool_name]),
        allowed_roles: Object.freeze([...(policy.allowed_roles ?? [])]),
      }),
    ];
  });
  return Object.freeze(Object.fromEntries(entries));
}

const READ_ENDPOINT_POLICIES = buildReadEndpointPolicies();

function parseBooleanEnv(value, fallbackValue) {
  if (value == null) {
    return fallbackValue;
  }
  if (typeof value !== "string") {
    return fallbackValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallbackValue;
}

function base64UrlDecodeToString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(401, "INVALID_AUTH_TOKEN", `${label} is missing`);
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(paddingLength);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    throw new HttpError(401, "INVALID_AUTH_TOKEN", `${label} is invalid`);
  }
}

function base64UrlDecodeToBuffer(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(401, "INVALID_AUTH_TOKEN", `${label} is missing`);
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(paddingLength);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    throw new HttpError(401, "INVALID_AUTH_TOKEN", `${label} is invalid`);
  }
}

function parseJsonFromTokenPart(part, label) {
  const raw = base64UrlDecodeToString(part, label);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be object");
    }
    return parsed;
  } catch {
    throw new HttpError(401, "INVALID_AUTH_TOKEN", `${label} must be valid JSON object`);
  }
}

function parseBearerToken(headers) {
  const authorizationHeader = lowerHeader(headers, "authorization");
  if (!authorizationHeader || authorizationHeader.trim() === "") {
    return null;
  }
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || typeof match[1] !== "string" || match[1].trim() === "") {
    throw new HttpError(401, "INVALID_AUTH_TOKEN", "Authorization header must use Bearer token");
  }
  return match[1].trim();
}

function verifyHs256Jwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new HttpError(401, "INVALID_AUTH_TOKEN", "Bearer token must be a JWT with three parts");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJsonFromTokenPart(encodedHeader, "JWT header");
  const payload = parseJsonFromTokenPart(encodedPayload, "JWT payload");
  const signature = base64UrlDecodeToBuffer(encodedSignature, "JWT signature");

  if (header.alg !== "HS256") {
    throw new HttpError(401, "INVALID_AUTH_TOKEN", "JWT alg must be HS256");
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac("sha256", secret).update(signingInput).digest();

  if (signature.length !== expectedSignature.length) {
    throw new HttpError(401, "INVALID_AUTH_TOKEN", "JWT signature is invalid");
  }
  if (!timingSafeEqual(signature, expectedSignature)) {
    throw new HttpError(401, "INVALID_AUTH_TOKEN", "JWT signature is invalid");
  }

  return payload;
}

function normalizeActorType(value, sourceLabel, fallbackType) {
  const candidate = value == null ? fallbackType : String(value).trim().toUpperCase();
  if (!ACTOR_TYPES.has(candidate)) {
    throw new HttpError(401, "INVALID_AUTH_CLAIMS", `${sourceLabel} must be a valid actor type`);
  }
  return candidate;
}

function normalizeRole(value, sourceLabel) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(401, "INVALID_AUTH_CLAIMS", `${sourceLabel} is required`);
  }
  const normalized = value.trim().toLowerCase();
  return ACTOR_ROLE_ALIASES[normalized] ?? normalized;
}

function normalizeActorId(value, sourceLabel) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(401, "INVALID_AUTH_CLAIMS", `${sourceLabel} is required`);
  }
  return value.trim();
}

function readNumericDateClaim(claims, key, { required }) {
  const value = claims[key];
  if (value == null) {
    if (required) {
      throw new HttpError(401, "INVALID_AUTH_CLAIMS", `JWT claim '${key}' is required`);
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(401, "INVALID_AUTH_CLAIMS", `JWT claim '${key}' must be numeric`);
  }
  return Math.floor(value);
}

function normalizeScopeEntries(value, fieldName) {
  if (value == null) {
    return [];
  }

  const rawEntries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.includes(",")
        ? value.split(",")
        : [value]
      : [value];

  return rawEntries.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new HttpError(
        401,
        "INVALID_AUTH_CLAIMS",
        `JWT claim '${fieldName}[${index}]' must be a non-empty string`,
      );
    }
    const normalized = entry.trim().toLowerCase();
    if (normalized === "*") {
      return "*";
    }
    if (!isUuid(normalized)) {
      throw new HttpError(
        401,
        "INVALID_AUTH_CLAIMS",
        `JWT claim '${fieldName}[${index}]' must be UUID or '*'`,
      );
    }
    return normalized;
  });
}

function normalizeClaimsScope(claims) {
  const scope = claims.scope;
  if (scope != null && (!scope || typeof scope !== "object" || Array.isArray(scope))) {
    throw new HttpError(
      401,
      "INVALID_AUTH_CLAIMS",
      "JWT claim 'scope' must be an object when provided",
    );
  }

  const scopeObject = scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {};

  const accountIds = normalizeScopeEntries(
    scopeObject.account_ids ?? claims.account_ids ?? claims.account_id ?? null,
    "account_ids",
  );
  const siteIds = normalizeScopeEntries(
    scopeObject.site_ids ?? claims.site_ids ?? claims.site_id ?? null,
    "site_ids",
  );

  return {
    account_ids: accountIds,
    site_ids: siteIds,
  };
}

function normalizeHeaderScopeEntries(rawHeaderValue, fieldName) {
  if (rawHeaderValue == null || rawHeaderValue.trim() === "") {
    return [];
  }

  return rawHeaderValue.split(",").map((entry, index) => {
    const trimmed = entry.trim();
    if (trimmed === "") {
      throw new HttpError(400, "INVALID_ACTOR_CONTEXT", `${fieldName}[${index}] must be non-empty`);
    }
    const normalized = trimmed.toLowerCase();
    if (normalized === "*") {
      return "*";
    }
    if (!isUuid(normalized)) {
      throw new HttpError(
        400,
        "INVALID_ACTOR_CONTEXT",
        `${fieldName}[${index}] must be UUID or '*'`,
      );
    }
    return normalized;
  });
}

function normalizeDevHeaderScope(headers) {
  const accountScope = normalizeHeaderScopeEntries(
    lowerHeader(headers, "x-account-scope"),
    "x-account-scope",
  );
  const siteScope = normalizeHeaderScopeEntries(
    lowerHeader(headers, "x-site-scope"),
    "x-site-scope",
  );
  return {
    account_ids: accountScope.length > 0 ? accountScope : ["*"],
    site_ids: siteScope.length > 0 ? siteScope : ["*"],
  };
}

function resolveEndpointPolicy(route) {
  if (!route || typeof route !== "object") {
    throw new HttpError(500, "INTERNAL_ERROR", "Route policy resolution failed");
  }

  if (route.kind === "command") {
    const commandPolicy = getCommandEndpointPolicy(route.endpoint);
    if (!commandPolicy) {
      throw new HttpError(500, "INTERNAL_ERROR", "Missing command authorization policy");
    }
    return {
      endpoint: route.endpoint,
      default_tool_name: commandPolicy.default_tool_name,
      allowed_tool_names: commandPolicy.allowed_tool_names,
      allowed_roles: commandPolicy.allowed_roles,
    };
  }

  if (
    route.kind === "ticket" ||
    route.kind === "timeline" ||
    route.kind === "evidence" ||
    route.kind === "dispatcher_cockpit" ||
    route.kind === "tech_job_packet"
  ) {
    const readPolicy = READ_ENDPOINT_POLICIES[route.endpoint];
    if (!readPolicy) {
      throw new HttpError(500, "INTERNAL_ERROR", "Missing read authorization policy");
    }
    return readPolicy;
  }

  return null;
}

function assertRoleAndToolAllowed(endpointPolicy, actorRole, toolName) {
  if (!endpointPolicy.allowed_roles.includes(actorRole)) {
    throw new HttpError(403, "FORBIDDEN", `Actor role '${actorRole}' is not allowed for endpoint`);
  }

  if (!endpointPolicy.allowed_tool_names.includes(toolName)) {
    throw new HttpError(403, "TOOL_NOT_ALLOWED", `Tool '${toolName}' is not allowed for endpoint`, {
      endpoint: endpointPolicy.endpoint,
      tool_name: toolName,
    });
  }
}

function parseActorFromClaims(token, headers, endpointPolicy, config) {
  if (!config.jwtSecret || config.jwtSecret.trim() === "") {
    throw new HttpError(
      500,
      "AUTH_CONFIG_ERROR",
      "DISPATCH_AUTH_JWT_SECRET is required for claims auth",
    );
  }

  const claims = verifyHs256Jwt(token, config.jwtSecret);
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const exp = readNumericDateClaim(claims, "exp", { required: true });
  const nbf = readNumericDateClaim(claims, "nbf", { required: false });

  if (exp <= nowEpochSeconds) {
    throw new HttpError(401, "INVALID_AUTH_CLAIMS", "JWT claim 'exp' is expired");
  }
  if (nbf != null && nbf > nowEpochSeconds) {
    throw new HttpError(401, "INVALID_AUTH_CLAIMS", "JWT claim 'nbf' is not yet valid");
  }

  if (config.jwtIssuer) {
    if (typeof claims.iss !== "string" || claims.iss.trim() !== config.jwtIssuer) {
      throw new HttpError(401, "INVALID_AUTH_CLAIMS", "JWT issuer claim is invalid");
    }
  }

  if (config.jwtAudience) {
    const audience = claims.aud;
    const audienceMatch =
      (typeof audience === "string" && audience.trim() === config.jwtAudience) ||
      (Array.isArray(audience) &&
        audience.some((entry) => typeof entry === "string" && entry.trim() === config.jwtAudience));
    if (!audienceMatch) {
      throw new HttpError(401, "INVALID_AUTH_CLAIMS", "JWT audience claim is invalid");
    }
  }

  const actorId = normalizeActorId(claims.sub, "JWT claim 'sub'");
  const actorRole = normalizeRole(claims.role, "JWT claim 'role'");
  const actorType = normalizeActorType(
    claims.actor_type ?? claims.actorType,
    "JWT claim 'actor_type'",
    "AGENT",
  );
  const toolNameHeader = lowerHeader(headers, "x-tool-name");
  const toolName = toolNameHeader?.trim() || endpointPolicy.default_tool_name;
  assertRoleAndToolAllowed(endpointPolicy, actorRole, toolName);

  return {
    actorId,
    actorRole,
    actorType,
    toolName,
    scope: normalizeClaimsScope(claims),
    authSource: "claims",
  };
}

function parseActorFromDevHeaders(headers, endpointPolicy) {
  const actorId = requireHeader(
    headers,
    "x-actor-id",
    "MISSING_ACTOR_CONTEXT",
    "Header 'X-Actor-Id' is required",
  );
  const actorRole = requireHeader(
    headers,
    "x-actor-role",
    "MISSING_ACTOR_CONTEXT",
    "Header 'X-Actor-Role' is required",
  );
  const resolvedActorRole = normalizeRole(actorRole, "Header 'X-Actor-Role'");
  const actorTypeRaw = lowerHeader(headers, "x-actor-type");
  const actorType = normalizeActorType(actorTypeRaw, "Header 'X-Actor-Type'", "HUMAN");
  const toolNameHeader = lowerHeader(headers, "x-tool-name");
  const toolName = toolNameHeader?.trim() || endpointPolicy.default_tool_name;

  assertRoleAndToolAllowed(endpointPolicy, resolvedActorRole, toolName);

  return {
    actorId,
    actorRole: resolvedActorRole,
    actorType,
    toolName,
    scope: normalizeDevHeaderScope(headers),
    authSource: "dev_headers",
  };
}

function hasScopeEntry(scopeEntries, targetId) {
  if (!Array.isArray(scopeEntries) || scopeEntries.length === 0) {
    return false;
  }
  if (scopeEntries.includes("*")) {
    return true;
  }
  return scopeEntries.includes(String(targetId).toLowerCase());
}

function assertScopeContains(scopeEntries, targetId, scopeName) {
  if (!Array.isArray(scopeEntries) || scopeEntries.length === 0) {
    throw new HttpError(403, "FORBIDDEN_SCOPE", `Actor is missing '${scopeName}' scope`);
  }
  if (!hasScopeEntry(scopeEntries, targetId)) {
    throw new HttpError(403, "FORBIDDEN_SCOPE", `Actor scope does not include ${scopeName}`, {
      scope_field: scopeName,
      target_id: targetId,
    });
  }
}

export function createAuthRuntime(options = {}) {
  const nodeEnv =
    typeof options.nodeEnv === "string" && options.nodeEnv.trim() !== ""
      ? options.nodeEnv.trim()
      : (process.env.NODE_ENV ?? "");
  const isProduction = nodeEnv.toLowerCase() === "production";

  let allowDevHeaders;
  if (typeof options.allowDevHeaders === "boolean") {
    allowDevHeaders = options.allowDevHeaders;
  } else {
    allowDevHeaders = parseBooleanEnv(process.env.DISPATCH_AUTH_ALLOW_DEV_HEADERS, !isProduction);
  }

  const jwtSecret =
    typeof options.jwtSecret === "string"
      ? options.jwtSecret
      : (process.env.DISPATCH_AUTH_JWT_SECRET ?? "");
  const jwtIssuer =
    typeof options.jwtIssuer === "string"
      ? options.jwtIssuer.trim() || null
      : (process.env.DISPATCH_AUTH_JWT_ISSUER ?? "").trim() || null;
  const jwtAudience =
    typeof options.jwtAudience === "string"
      ? options.jwtAudience.trim() || null
      : (process.env.DISPATCH_AUTH_JWT_AUDIENCE ?? "").trim() || null;

  const config = Object.freeze({
    allowDevHeaders: Boolean(allowDevHeaders),
    jwtSecret,
    jwtIssuer,
    jwtAudience,
  });

  return {
    resolveActor(headers, route) {
      const endpointPolicy = resolveEndpointPolicy(route);
      if (!endpointPolicy) {
        return null;
      }

      const token = parseBearerToken(headers);
      if (token) {
        return parseActorFromClaims(token, headers, endpointPolicy, config);
      }

      if (config.allowDevHeaders) {
        return parseActorFromDevHeaders(headers, endpointPolicy);
      }

      throw new HttpError(401, "AUTH_REQUIRED", "Signed Bearer token is required");
    },
    assertActorScopeForTarget(actor, target) {
      const accountId = target?.accountId ?? target?.account_id;
      const siteId = target?.siteId ?? target?.site_id;

      if (!isUuid(accountId) || !isUuid(siteId)) {
        throw new HttpError(
          500,
          "INTERNAL_ERROR",
          "Scope target must include valid account_id and site_id",
        );
      }

      const accountScope = actor?.scope?.account_ids ?? [];
      const siteScope = actor?.scope?.site_ids ?? [];
      assertScopeContains(accountScope, accountId, "account_id");
      assertScopeContains(siteScope, siteId, "site_id");
    },
  };
}
