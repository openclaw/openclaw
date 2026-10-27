import { normalizeJsonSchemaForTypeBox } from "openclaw/plugin-sdk/json-schema-runtime";
import rawDynamicToolCallParamsSchema from "./protocol-generated/json/DynamicToolCallParams.json" with { type: "json" };
import sharedDefinitionsSchema from "./protocol-generated/json/v2/CodexAppServerProtocolDefinitions.json" with { type: "json" };
import rawErrorNotificationSchema from "./protocol-generated/json/v2/ErrorNotification.json" with { type: "json" };
import rawModelListResponseSchema from "./protocol-generated/json/v2/ModelListResponse.json" with { type: "json" };
import rawThreadResumeResponseSchema from "./protocol-generated/json/v2/ThreadResumeResponse.json" with { type: "json" };
import rawThreadStartResponseSchema from "./protocol-generated/json/v2/ThreadStartResponse.json" with { type: "json" };
import rawTurnCompletedNotificationSchema from "./protocol-generated/json/v2/TurnCompletedNotification.json" with { type: "json" };
import rawTurnStartResponseSchema from "./protocol-generated/json/v2/TurnStartResponse.json" with { type: "json" };

/** The same normalized resources own build-time checks and runtime error diagnostics. */
export function createCodexValidationSchemas() {
  const schemaBaseUrl = "https://openclaw.invalid/codex/";
  const sharedDefinitionsId = new URL("v2/CodexAppServerProtocolDefinitions.json", schemaBaseUrl)
    .href;
  const normalize = (schema: Record<string, unknown>, name: string) =>
    normalizeJsonSchemaForTypeBox({ ...schema, $id: new URL(name, schemaBaseUrl).href });

  const codexErrorInfoSchema = sharedDefinitionsSchema.definitions.CodexErrorInfo;
  // Preserve known variant constraints when the upstream open enum accepts future errors.
  const knownErrorVariantConstraints = codexErrorInfoSchema.anyOf.flatMap((variant) =>
    "required" in variant
      ? [{ anyOf: [{ not: { type: "object", required: variant.required } }, variant] }]
      : [],
  );

  return {
    context: {
      [sharedDefinitionsId]: normalizeJsonSchemaForTypeBox({
        ...sharedDefinitionsSchema,
        $id: sharedDefinitionsId,
        definitions: {
          ...sharedDefinitionsSchema.definitions,
          CodexErrorInfo: {
            ...codexErrorInfoSchema,
            allOf: knownErrorVariantConstraints,
          },
        },
      }),
    },
    schemas: {
      CodexDynamicToolCallParams: normalize(
        rawDynamicToolCallParamsSchema,
        "DynamicToolCallParams.json",
      ),
      CodexErrorNotification: normalize(rawErrorNotificationSchema, "v2/ErrorNotification.json"),
      CodexModelListResponse: normalize(rawModelListResponseSchema, "v2/ModelListResponse.json"),
      CodexThreadResumeResponse: normalize(
        rawThreadResumeResponseSchema,
        "v2/ThreadResumeResponse.json",
      ),
      CodexThreadStartResponse: normalize(
        rawThreadStartResponseSchema,
        "v2/ThreadStartResponse.json",
      ),
      CodexTurnCompletedNotification: normalize(
        rawTurnCompletedNotificationSchema,
        "v2/TurnCompletedNotification.json",
      ),
      CodexTurnStartResponse: normalize(rawTurnStartResponseSchema, "v2/TurnStartResponse.json"),
    },
  };
}
