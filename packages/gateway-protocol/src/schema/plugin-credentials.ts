import { Type, type Static } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";

const text = Type.String({ minLength: 1, maxLength: 512 });
const path = Type.Array(Type.Union([text, Type.Integer({ minimum: 0 })]), {
  minItems: 5,
  maxItems: 32,
});
export const PluginCredentialDescriptorSchema = closedObject({
  path,
  label: text,
  envVars: Type.Array(text, { maxItems: 32 }),
  placeholder: Type.Optional(text),
  signupUrl: Type.Optional(text),
  requiresCredential: Type.Optional(Type.Boolean()),
});

const reference = closedObject({
  source: Type.Union([
    Type.Literal("env"),
    Type.Literal("file"),
    Type.Literal("exec"),
    Type.Literal("store"),
  ]),
  provider: text,
  id: Type.String({ minLength: 1, maxLength: 4096 }),
});
export const PluginCredentialInspectionSchema = Type.Union([
  closedObject({ kind: Type.Literal("missing") }),
  closedObject({ kind: Type.Literal("literal"), value: Type.Optional(Type.String()) }),
  closedObject({ kind: Type.Literal("invalid") }),
  closedObject({ kind: Type.Literal("environment"), envVar: text }),
  closedObject({ kind: Type.Literal("reference"), ref: reference, unresolved: Type.Boolean() }),
]);
/** An admin can inspect only a credential advertised by this installed plugin, at this revision. */
export const PluginsCredentialsInspectParamsSchema = closedObject({
  pluginId: text,
  path,
  baseHash: text,
  reveal: Type.Optional(Type.Boolean()),
});
export const PluginsCredentialsInspectResultSchema = closedObject({
  baseHash: text,
  credential: PluginCredentialInspectionSchema,
});
export type PluginCredentialDescriptor = Static<typeof PluginCredentialDescriptorSchema>;
export type PluginCredentialInspection = Static<typeof PluginCredentialInspectionSchema>;
export type PluginsCredentialsInspectParams = Static<typeof PluginsCredentialsInspectParamsSchema>;
export type PluginsCredentialsInspectResult = Static<typeof PluginsCredentialsInspectResultSchema>;
export const validatePluginsCredentialsInspectParams = lazyCompile(
  PluginsCredentialsInspectParamsSchema,
);
