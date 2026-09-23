import { Type, type Static } from "typebox";
import { lazyCompile } from "../protocol-validator.js";

const closed = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 512 });
const path = Type.Array(Type.Union([text, Type.Integer({ minimum: 0 })]), {
  minItems: 5,
  maxItems: 32,
});
export const PluginCredentialDescriptorSchema = Type.Object(
  {
    path,
    label: text,
    envVars: Type.Array(text, { maxItems: 32 }),
    placeholder: Type.Optional(text),
    signupUrl: Type.Optional(text),
    requiresCredential: Type.Optional(Type.Boolean()),
    storage: Type.Optional(Type.Literal("protected")),
  },
  closed,
);

const reference = Type.Object(
  {
    source: Type.Union([
      Type.Literal("env"),
      Type.Literal("file"),
      Type.Literal("exec"),
      Type.Literal("store"),
    ]),
    provider: text,
    id: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  closed,
);
export const PluginCredentialInspectionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("missing") }, closed),
  Type.Object({ kind: Type.Literal("literal"), value: Type.Optional(Type.String()) }, closed),
  Type.Object({ kind: Type.Literal("invalid") }, closed),
  Type.Object({ kind: Type.Literal("environment"), envVar: text }, closed),
  Type.Object(
    { kind: Type.Literal("reference"), ref: reference, unresolved: Type.Boolean() },
    closed,
  ),
]);
/** An admin can inspect only a credential advertised by this installed plugin, at this revision. */
export const PluginsCredentialsInspectParamsSchema = Type.Object(
  { pluginId: text, path, baseHash: text, reveal: Type.Optional(Type.Boolean()) },
  closed,
);
export const PluginsCredentialsInspectResultSchema = Type.Object(
  {
    baseHash: text,
    credential: PluginCredentialInspectionSchema,
  },
  closed,
);
export type PluginCredentialDescriptor = Static<typeof PluginCredentialDescriptorSchema>;
export type PluginCredentialInspection = Static<typeof PluginCredentialInspectionSchema>;
export type PluginsCredentialsInspectParams = Static<typeof PluginsCredentialsInspectParamsSchema>;
export type PluginsCredentialsInspectResult = Static<typeof PluginsCredentialsInspectResultSchema>;
export const validatePluginsCredentialsInspectParams = lazyCompile(
  PluginsCredentialsInspectParamsSchema,
);

export const PluginsCredentialsSetParamsSchema = Type.Object(
  { pluginId: text, path, baseHash: text, value: Type.String({ minLength: 1, maxLength: 65536 }) },
  closed,
);
export const PluginsCredentialsSetResultSchema = Type.Object(
  { saved: Type.Literal(true), warning: Type.Optional(Type.String()) },
  closed,
);
export type PluginsCredentialsSetParams = Static<typeof PluginsCredentialsSetParamsSchema>;
export type PluginsCredentialsSetResult = Static<typeof PluginsCredentialsSetResultSchema>;
export const validatePluginsCredentialsSetParams = lazyCompile(PluginsCredentialsSetParamsSchema);
