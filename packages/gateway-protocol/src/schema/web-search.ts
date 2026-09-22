import { Type, type Static } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { PluginCredentialDescriptorSchema } from "./plugin-credentials.js";

const closed = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 512, pattern: "\\S" });
const selection = {
  agentId: Type.Optional(text),
  modelProvider: Type.Optional(text),
  modelId: Type.Optional(text),
};
export const WebSearchStatusParamsSchema = Type.Object(selection, closed);
export const WebSearchTestParamsSchema = Type.Object(
  {
    ...selection,
    query: Type.String({ minLength: 1, maxLength: 500 }),
    providerId: Type.Optional(text),
  },
  closed,
);
const route = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("native"),
      Type.Literal("external"),
      Type.Literal("managed"),
      Type.Literal("disabled"),
      Type.Literal("unavailable"),
    ]),
    provider: Type.Optional(text),
    label: text,
    reason: Type.Optional(Type.String()),
    testable: Type.Boolean(),
  },
  closed,
);
export const WebSearchStatusResultSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    provider: Type.Union([text, Type.Null()]),
    agentId: text,
    model: Type.Object(
      { provider: text, id: text, runtime: text, runtimeLabel: Type.Optional(text) },
      closed,
    ),
    route,
    testProvider: Type.Optional(Type.Object({ id: text, label: text }, closed)),
    providers: Type.Array(
      Type.Object(
        {
          id: text,
          pluginId: text,
          label: text,
          hint: Type.String(),
          configured: Type.Boolean(),
          installed: Type.Boolean(),
          available: Type.Boolean(),
          requiresCredential: Type.Boolean(),
          credentialSource: Type.Union([
            Type.Literal("config"),
            Type.Literal("secretRef"),
            Type.Literal("env"),
            Type.Literal("auth-profile"),
            Type.Literal("none"),
            Type.Literal("missing"),
          ]),
          credential: Type.Optional(PluginCredentialDescriptorSchema),
          credentialPath: Type.Optional(text),
          configPath: Type.Array(text),
          docsUrl: Type.Optional(text),
          signupUrl: Type.Optional(text),
        },
        closed,
      ),
    ),
  },
  closed,
);
const citation = Type.Object({ url: Type.String(), title: Type.Optional(Type.String()) }, closed);
export const WebSearchTestResultSchema = Type.Object(
  {
    provider: text,
    latencyMs: Type.Number({ minimum: 0 }),
    status: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
    error: Type.Optional(Type.String()),
    content: Type.Optional(Type.String()),
    results: Type.Optional(
      Type.Array(
        Type.Object(
          { title: Type.String(), url: Type.String(), snippet: Type.Optional(Type.String()) },
          closed,
        ),
      ),
    ),
    citations: Type.Optional(Type.Array(citation)),
    cached: Type.Optional(Type.Boolean()),
  },
  closed,
);
export type WebSearchStatusParams = Static<typeof WebSearchStatusParamsSchema>;
export type WebSearchStatusResult = Static<typeof WebSearchStatusResultSchema>;
export type WebSearchTestParams = Static<typeof WebSearchTestParamsSchema>;
export type WebSearchTestResult = Static<typeof WebSearchTestResultSchema>;
export const validateWebSearchStatusParams = lazyCompile(WebSearchStatusParamsSchema);
export const validateWebSearchTestParams = lazyCompile(WebSearchTestParamsSchema);
