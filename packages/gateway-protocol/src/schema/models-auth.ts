// Gateway Protocol schema module for model-provider credential methods.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Reads model-provider credential health for one configured agent. */
export const ModelsAuthStatusParamsSchema = closedObject({
  refresh: Type.Optional(Type.Boolean()),
  /** Await cold or stale provider usage using prepared credentials, without refreshing auth. */
  refreshUsage: Type.Optional(Type.Boolean()),
  agentId: Type.Optional(Type.String()),
});

/** Rebuilds Gateway auth state after a credential or selection mutation. */
export const ModelsAuthRefreshParamsSchema = closedObject({
  operation: Type.Union([Type.Literal("login"), Type.Literal("logout"), Type.Literal("update")]),
  agentId: Type.Optional(Type.String()),
});

/** Saves a model-provider API key without changing model selection. */
export const ModelsAuthSetApiKeyParamsSchema = Type.Object(
  {
    provider: Type.String({ pattern: "\\S" }),
    apiKey: Type.String({ pattern: "\\S" }),
    agentId: Type.Optional(Type.String()),
  },
  // Existing wire clients may send extra fields; the handler ignores them.
  { additionalProperties: true },
);

export const ModelsAuthSetApiKeyResultSchema = closedObject({
  provider: NonEmptyString,
  profileId: NonEmptyString,
  warning: Type.Optional(Type.String()),
});

/** Removes saved model-provider credentials from one agent; `revoke` first revokes one OAuth grant. */
export const ModelsAuthLogoutParamsSchema = closedObject({
  provider: NonEmptyString,
  profileIds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  credentialType: Type.Optional(Type.Literal("api_key")),
  revoke: Type.Optional(Type.Literal(true)),
  agentId: Type.Optional(Type.String()),
});

/** Sets or clears the preferred auth-profile order for one provider and agent. */
export const ModelsAuthOrderSetParamsSchema = closedObject({
  provider: NonEmptyString,
  profileIds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true })),
  agentId: Type.Optional(Type.String()),
});

export type ModelsAuthSetApiKeyParams = Static<typeof ModelsAuthSetApiKeyParamsSchema>;
export type ModelsAuthSetApiKeyResult = Static<typeof ModelsAuthSetApiKeyResultSchema>;
export type ModelsAuthStatusParams = Static<typeof ModelsAuthStatusParamsSchema>;
export type ModelsAuthLogoutParams = Static<typeof ModelsAuthLogoutParamsSchema>;
export type ModelsAuthOrderSetParams = Static<typeof ModelsAuthOrderSetParamsSchema>;
export type ModelsAuthRefreshParams = Static<typeof ModelsAuthRefreshParamsSchema>;
