import { Type, type TSchema } from "typebox";
import { closedObject } from "./closed-object.js";
import type { PluginDeclaredSurfaceGroup } from "./plugin-declared-surface-groups.js";
import { NonEmptyString } from "./primitives.js";

/** Effective operator hook-policy grant with optional explicit config value. */
export const PluginHookGrantSchema = closedObject({
  /** Effective policy after origin defaults and operator config. */
  effective: Type.Boolean(),
  /** Present only when plugins.entries.<id>.hooks sets the flag explicitly. */
  configured: Type.Optional(Type.Boolean()),
});

/** Install provenance and pinned artifact integrity for one plugin. */
export const PluginInspectSourceSchema = closedObject({
  kind: Type.Union([
    Type.Literal("bundled"),
    Type.Literal("clawhub"),
    Type.Literal("npm"),
    Type.Literal("git"),
    Type.Literal("path"),
    Type.Literal("archive"),
    Type.Literal("marketplace"),
    Type.Literal("official-catalog"),
  ]),
  spec: Type.Optional(NonEmptyString),
  packageName: Type.Optional(NonEmptyString),
  /** Pinned artifact integrity recorded at install (npm SSRI, sha-256, or git commit). */
  integrity: Type.Optional(NonEmptyString),
  integrityKind: Type.Optional(
    Type.Union([Type.Literal("ssri"), Type.Literal("sha256"), Type.Literal("git-commit")]),
  ),
});

/** Manifest-declared capability surface in enumerable terms. All arrays sorted. */
export const PluginDeclaredSurfaceSchema = closedObject({
  channels: Type.Array(NonEmptyString),
  providers: Type.Array(NonEmptyString),
  tools: Type.Array(NonEmptyString),
  /** Manifest contract families and identifiers, rendered as `family: id`. */
  contracts: Type.Array(NonEmptyString),
  /** Bundle-format hook names; code plugins register hooks at runtime and list nothing here. */
  hooks: Type.Array(NonEmptyString),
  mcpServers: Type.Array(NonEmptyString),
  cliCommands: Type.Array(NonEmptyString),
  cliBackends: Type.Array(NonEmptyString),
  skills: Type.Array(NonEmptyString),
  /** Dot paths from configContracts.dangerousFlags. */
  dangerousConfigFlags: Type.Array(NonEmptyString),
} satisfies Record<PluginDeclaredSurfaceGroup, TSchema>);

/** Operator-granted capability flags with effective values. */
export const PluginOperatorGrantsSchema = closedObject({
  hooks: closedObject({
    allowPromptInjection: PluginHookGrantSchema,
    allowConversationAccess: PluginHookGrantSchema,
  }),
  llm: Type.Optional(
    closedObject({
      allowModelOverride: Type.Optional(Type.Boolean()),
      allowedModels: Type.Optional(Type.Array(NonEmptyString)),
      allowedCompletionModels: Type.Optional(Type.Array(NonEmptyString)),
      allowAuthProfileOverride: Type.Optional(Type.Boolean()),
      allowAgentIdOverride: Type.Optional(Type.Boolean()),
    }),
  ),
  subagent: Type.Optional(
    closedObject({
      allowModelOverride: Type.Optional(Type.Boolean()),
      allowedModels: Type.Optional(Type.Array(NonEmptyString)),
    }),
  ),
});

/** Persisted ClawHub per-release trust verdict from the install record. */
export const PluginInstallTrustSchema = closedObject({
  disposition: Type.Union([
    Type.Literal("clean"),
    Type.Literal("review-recommended"),
    Type.Literal("review-required"),
    Type.Literal("blocked"),
  ]),
  reasons: Type.Optional(Type.Array(Type.String())),
  checkedAt: Type.Optional(NonEmptyString),
  acknowledgedAt: Type.Optional(NonEmptyString),
  pending: Type.Optional(Type.Boolean()),
  stale: Type.Optional(Type.Boolean()),
});

/** Runtime-supported installed component lists plus detected-but-unavailable bundle facts. */
export const PluginInstalledComponentsSchema = closedObject({
  /** Runtime-supported capability families; item arrays may be empty when names are unavailable. */
  mapped: Type.Array(NonEmptyString),
  skills: Type.Array(NonEmptyString),
  skillDetails: Type.Optional(
    Type.Array(
      closedObject({
        name: NonEmptyString,
        description: Type.Optional(Type.String()),
      }),
    ),
  ),
  mcpServers: Type.Array(NonEmptyString),
  commands: Type.Array(NonEmptyString),
  hooks: Type.Array(NonEmptyString),
  lspServers: Type.Array(NonEmptyString),
  unavailable: closedObject({
    capabilities: Type.Array(NonEmptyString),
    mcpServers: Type.Array(NonEmptyString),
    lspServers: Type.Array(NonEmptyString),
  }),
});

/** Instance-local decision provider health; contains no evidence or credential details. */
export const PluginDecisionProviderStatusSchema = closedObject({
  providerId: NonEmptyString,
  pluginId: NonEmptyString,
  configured: Type.Boolean(),
  credentialReady: Type.Boolean(),
  callable: Type.Boolean(),
  runtimeGeneration: NonEmptyString,
  recentSuccessAt: Type.Optional(Type.Integer({ minimum: 0 })),
  activeRequests: Type.Integer({ minimum: 0 }),
  successCount: Type.Integer({ minimum: 0 }),
  totalLatencyMs: Type.Number({ minimum: 0 }),
  usage: closedObject({
    inputTokens: Type.Number({ minimum: 0 }),
    outputTokens: Type.Number({ minimum: 0 }),
  }),
  reasons: Type.Partial(
    closedObject({
      "credentials-unavailable": Type.Integer({ minimum: 0 }),
      authentication: Type.Integer({ minimum: 0 }),
      "rate-limited": Type.Integer({ minimum: 0 }),
      transport: Type.Integer({ minimum: 0 }),
      "unsupported-input": Type.Integer({ minimum: 0 }),
      "invalid-response": Type.Integer({ minimum: 0 }),
      disabled: Type.Integer({ minimum: 0 }),
      "not-configured": Type.Integer({ minimum: 0 }),
      retiring: Type.Integer({ minimum: 0 }),
      overloaded: Type.Integer({ minimum: 0 }),
      "circuit-open": Type.Integer({ minimum: 0 }),
      deadline: Type.Integer({ minimum: 0 }),
    }),
    { additionalProperties: false },
  ),
});
