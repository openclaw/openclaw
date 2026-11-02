import { Type, type Static } from "typebox";
import * as Checks from "../compiled/protocol.generated/schema-web-search.js";
import { createProtocolValidator } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";
import { PluginCredentialDescriptorSchema } from "./plugin-credentials.js";
import { stringLiteralUnion } from "./string-literal-union.js";

const text = Type.String({ minLength: 1, maxLength: 512, pattern: "\\S" });
const selection = {
  agentId: Type.Optional(text),
  modelProvider: Type.Optional(text),
  modelId: Type.Optional(text),
};
export const WebSearchStatusParamsSchema = closedObject(selection);
export const WebSearchTestParamsSchema = closedObject({
  ...selection,
  query: Type.String({ minLength: 1, maxLength: 500 }),
  providerId: Type.Optional(text),
});
const route = closedObject({
  kind: stringLiteralUnion(["native", "external", "managed", "disabled", "unavailable"]),
  provider: Type.Optional(text),
  label: text,
  reason: Type.Optional(Type.String()),
  testable: Type.Boolean(),
});
export const WebSearchStatusResultSchema = closedObject({
  enabled: Type.Boolean(),
  provider: Type.Union([text, Type.Null()]),
  agentId: text,
  model: closedObject({
    provider: text,
    id: text,
    runtime: text,
    runtimeLabel: Type.Optional(text),
  }),
  route,
  testProvider: Type.Optional(closedObject({ id: text, label: text })),
  providers: Type.Array(
    closedObject({
      id: text,
      pluginId: text,
      label: text,
      hint: Type.String(),
      configured: Type.Boolean(),
      installed: Type.Boolean(),
      available: Type.Boolean(),
      requiresCredential: Type.Boolean(),
      credentialSource: stringLiteralUnion([
        "config",
        "secretRef",
        "env",
        "auth-profile",
        "none",
        "missing",
      ]),
      credential: Type.Optional(PluginCredentialDescriptorSchema),
      credentialPath: Type.Optional(text),
      configPath: Type.Array(text),
      docsUrl: Type.Optional(text),
      signupUrl: Type.Optional(text),
    }),
  ),
});
const citation = closedObject({ url: Type.String(), title: Type.Optional(Type.String()) });
export const WebSearchTestResultSchema = closedObject({
  provider: text,
  latencyMs: Type.Number({ minimum: 0 }),
  status: stringLiteralUnion(["ok", "error"]),
  error: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  results: Type.Optional(
    Type.Array(
      closedObject({
        title: Type.String(),
        url: Type.String(),
        snippet: Type.Optional(Type.String()),
      }),
    ),
  ),
  citations: Type.Optional(Type.Array(citation)),
  cached: Type.Optional(Type.Boolean()),
});
export type WebSearchStatusParams = Static<typeof WebSearchStatusParamsSchema>;
export type WebSearchStatusResult = Static<typeof WebSearchStatusResultSchema>;
export type WebSearchTestParams = Static<typeof WebSearchTestParamsSchema>;
export type WebSearchTestResult = Static<typeof WebSearchTestResultSchema>;
export const validateWebSearchStatusParams = createProtocolValidator(
  WebSearchStatusParamsSchema,
  Checks.isWebSearchStatusParams,
);
export const validateWebSearchTestParams = createProtocolValidator(
  WebSearchTestParamsSchema,
  Checks.isWebSearchTestParams,
);
