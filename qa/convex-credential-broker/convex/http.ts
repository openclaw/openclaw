// Http module supports OpenClaw QA credential workflows.
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, type ActionCtx } from "./_generated/server";
import { normalizeCredentialPayloadForKind } from "./payload_validation";

type ActorRole = "ci" | "maintainer";

class BrokerHttpError extends Error {
  code: string;
  httpStatus: number;

  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.name = "BrokerHttpError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseBearerToken(request: Request) {
  const header = request.headers.get("authorization")?.trim();
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(/\s+/u, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

function resolveAuthRole(token: string | null, maintainerOnly = false): ActorRole {
  if (!token) {
    throw new BrokerHttpError(
      401,
      "AUTH_REQUIRED",
      "Missing Authorization: Bearer <secret> header.",
    );
  }
  const maintainerSecret = process.env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER?.trim();
  let ciSecret = maintainerOnly ? undefined : process.env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim();
  if (!maintainerSecret && (maintainerOnly || !ciSecret)) {
    throw new BrokerHttpError(
      500,
      "SERVER_MISCONFIGURED",
      maintainerOnly
        ? "Admin endpoints require OPENCLAW_QA_CONVEX_SECRET_MAINTAINER on this deployment."
        : "No Convex broker role secrets are configured on this deployment.",
    );
  }
  if (maintainerSecret && token === maintainerSecret) {
    return "maintainer";
  }
  if (maintainerOnly) {
    ciSecret = process.env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim();
  }
  if (ciSecret && token === ciSecret) {
    if (maintainerOnly) {
      throw new BrokerHttpError(
        403,
        "AUTH_ROLE_MISMATCH",
        "Admin endpoints require maintainer credentials.",
      );
    }
    return "ci";
  }
  throw new BrokerHttpError(401, "AUTH_INVALID", "Credential broker secret is invalid.");
}

function readJsonObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function parseJsonObject(request: Request) {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new BrokerHttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const body = readJsonObject(parsed);
  if (!body) {
    throw new BrokerHttpError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  return body;
}

function requireString(body: Record<string, unknown>, key: string) {
  const raw = body[key];
  if (typeof raw !== "string") {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be a string.`);
  }
  const value = raw.trim();
  if (!value) {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be non-empty.`);
  }
  return value;
}

function readOptionalHttpString(body: Record<string, unknown>, key: string) {
  if (!(key in body) || body[key] === undefined || body[key] === null) {
    return undefined;
  }
  const raw = body[key];
  if (typeof raw !== "string") {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be a string.`);
  }
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function requireObject(body: Record<string, unknown>, key: string) {
  const raw = body[key];
  const parsed = readJsonObject(raw);
  if (!parsed) {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be a JSON object.`);
  }
  return parsed;
}

function optionalInteger(body: Record<string, unknown>, key: string, minimum: 0 | 1 = 1) {
  if (!(key in body) || body[key] === undefined || body[key] === null) {
    return undefined;
  }
  const raw = body[key];
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < minimum) {
    throw new BrokerHttpError(
      400,
      "INVALID_BODY",
      `Expected "${key}" to be a ${minimum === 0 ? "non-negative" : "positive"} integer.`,
    );
  }
  return raw;
}

function optionalBoolean(body: Record<string, unknown>, key: string) {
  if (!(key in body) || body[key] === undefined || body[key] === null) {
    return undefined;
  }
  if (typeof body[key] !== "boolean") {
    throw new BrokerHttpError(400, "INVALID_BODY", `Expected "${key}" to be a boolean.`);
  }
  return body[key];
}

function optionalCredentialStatus(body: Record<string, unknown>, key: string) {
  const value = readOptionalHttpString(body, key);
  if (!value) {
    return undefined;
  }
  if (value !== "active" && value !== "disabled") {
    throw new BrokerHttpError(
      400,
      "INVALID_BODY",
      `Expected "${key}" to be "active" or "disabled".`,
    );
  }
  return value;
}

function optionalListStatus(body: Record<string, unknown>, key: string) {
  const value = readOptionalHttpString(body, key);
  if (!value) {
    return undefined;
  }
  if (value !== "active" && value !== "disabled" && value !== "all") {
    throw new BrokerHttpError(
      400,
      "INVALID_BODY",
      `Expected "${key}" to be "active", "disabled", or "all".`,
    );
  }
  return value;
}

function parseActorRole(body: Record<string, unknown>) {
  const actorRole = requireString(body, "actorRole");
  if (actorRole !== "ci" && actorRole !== "maintainer") {
    throw new BrokerHttpError(
      400,
      "INVALID_ACTOR_ROLE",
      'Expected "actorRole" to be "maintainer" or "ci".',
    );
  }
  return actorRole as ActorRole;
}

function assertRoleAllowed(tokenRole: ActorRole, requestedRole: ActorRole) {
  if (tokenRole !== requestedRole) {
    throw new BrokerHttpError(
      403,
      "AUTH_ROLE_MISMATCH",
      `Secret role "${tokenRole}" cannot be used as actorRole "${requestedRole}".`,
    );
  }
}

function normalizeError(error: unknown) {
  if (error instanceof BrokerHttpError) {
    return {
      httpStatus: error.httpStatus,
      payload: {
        status: "error",
        code: error.code,
        message: error.message,
      },
    };
  }

  return {
    httpStatus: 500,
    payload: {
      status: "error",
      code: "INTERNAL_ERROR",
      message:
        error instanceof Error
          ? error.message || "Internal credential broker error."
          : "Internal credential broker error.",
    },
  };
}

const http = httpRouter();

function registerPost<T>(
  path: string,
  parseRequest: (request: Request) => Promise<T>,
  handle: (ctx: ActionCtx, input: T) => Promise<unknown>,
) {
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      try {
        return jsonResponse(200, await handle(ctx, await parseRequest(request)));
      } catch (error) {
        const normalized = normalizeError(error);
        return jsonResponse(normalized.httpStatus, normalized.payload);
      }
    }),
  });
}

async function parseLeaseRequest(request: Request) {
  const tokenRole = resolveAuthRole(parseBearerToken(request));
  const body = await parseJsonObject(request);
  const actorRole = parseActorRole(body);
  assertRoleAllowed(tokenRole, actorRole);
  return { body, actorRole };
}

async function parseAdminRequest(request: Request) {
  resolveAuthRole(parseBearerToken(request), true);
  return await parseJsonObject(request);
}

function readLeaseTarget(body: Record<string, unknown>, actorRole: ActorRole) {
  return {
    kind: requireString(body, "kind"),
    ownerId: requireString(body, "ownerId"),
    actorRole,
    credentialId: requireString(body, "credentialId") as Id<"credential_sets">,
    leaseToken: requireString(body, "leaseToken"),
  };
}

registerPost("/qa-credentials/v1/acquire", parseLeaseRequest, async (ctx, { body, actorRole }) => {
  const kind = requireString(body, "kind");
  const ownerId = requireString(body, "ownerId");
  const prepared = await ctx.runQuery(internal.credentials.prepareLeaseAcquisition, {
    kind,
    leaseTtlMs: optionalInteger(body, "leaseTtlMs"),
    heartbeatIntervalMs: optionalInteger(body, "heartbeatIntervalMs"),
  });
  if (prepared.status !== "ok") return prepared;
  for (const credentialId of prepared.credentialIds) {
    const result = await ctx.runMutation(internal.credentials.tryAcquireLease, {
      kind,
      ownerId,
      actorRole,
      credentialId,
      leaseTtlMs: prepared.leaseTtlMs,
      heartbeatIntervalMs: prepared.heartbeatIntervalMs,
    });
    if (result.status === "ok") return result;
  }
  const exhausted = await ctx.runMutation(internal.credentials.recordLeaseAcquisitionFailure, {
    kind,
    ownerId,
    actorRole,
  });
  return exhausted;
});

registerPost(
  "/qa-credentials/v1/heartbeat",
  parseLeaseRequest,
  async (ctx, { body, actorRole }) => {
    return ctx.runMutation(internal.credentials.heartbeatLease, {
      ...readLeaseTarget(body, actorRole),
      leaseTtlMs: optionalInteger(body, "leaseTtlMs"),
    });
  },
);

registerPost(
  "/qa-credentials/v1/payload-chunk",
  parseLeaseRequest,
  async (ctx, { body, actorRole }) => {
    return ctx.runQuery(internal.credentials.getPayloadChunk, {
      ...readLeaseTarget(body, actorRole),
      index: optionalInteger(body, "index", 0) ?? 0,
    });
  },
);

registerPost("/qa-credentials/v1/release", parseLeaseRequest, async (ctx, { body, actorRole }) => {
  return ctx.runMutation(internal.credentials.releaseLease, {
    ...readLeaseTarget(body, actorRole),
  });
});

registerPost("/qa-credentials/v1/admin/add", parseAdminRequest, async (ctx, body) => {
  const kind = requireString(body, "kind");
  const payload = normalizeCredentialPayloadForKind(
    kind,
    requireObject(body, "payload"),
    (httpStatus, code, message) => new BrokerHttpError(httpStatus, code, message),
  );
  return ctx.runMutation(internal.credentials.addCredentialSet, {
    kind,
    payload,
    note: readOptionalHttpString(body, "note"),
    actorId: readOptionalHttpString(body, "actorId"),
    status: optionalCredentialStatus(body, "status"),
  });
});

registerPost("/qa-credentials/v1/admin/remove", parseAdminRequest, async (ctx, body) => {
  return ctx.runMutation(internal.credentials.disableCredentialSet, {
    credentialId: requireString(body, "credentialId") as Id<"credential_sets">,
    actorId: readOptionalHttpString(body, "actorId"),
  });
});

registerPost("/qa-credentials/v1/admin/list", parseAdminRequest, async (ctx, body) => {
  return ctx.runQuery(internal.credentials.listCredentialSets, {
    kind: readOptionalHttpString(body, "kind"),
    status: optionalListStatus(body, "status"),
    includePayload: optionalBoolean(body, "includePayload"),
    limit: optionalInteger(body, "limit"),
  });
});

export default http;
