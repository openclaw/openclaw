import { promises as fs } from "node:fs";
import path from "node:path";
import { ProtocolSchemas } from "../packages/gateway-protocol/src/schema/protocol-schemas.js";
import {
  MIN_NODE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../packages/gateway-protocol/src/version.js";
import { listCoreGatewayMethodNames } from "../src/gateway/methods/core-method-policy.js";
import { extractGatewayEventNames } from "./check-protocol-event-coverage.mts";
import { lowerCamel, upperCamel } from "./lib/protocol-codegen-names.mts";
import { type JsonSchema, schemaSignature } from "./lib/protocol-codegen-schema.js";

type EnumSpec = {
  name: string;
  values: Array<{ name: string; rawValue: string }>;
  namespacePrefix?: string;
};

const protocolSchemas = ProtocolSchemas as Record<string, JsonSchema>;

const schemaNames = new Map<string, string>([
  ["ErrorShape", "GatewayProtocolError"],
  ["RequestFrame", "GatewayRequestFrame"],
  ["ResponseFrame", "GatewayResponseFrame"],
  ["EventFrame", "GatewayEventFrame"],
  ["NodeEventParams", "GatewayNodeEventParams"],
  ["NodeInvokeResultParams", "GatewayNodeInvokeResultParams"],
  ["NodeInvokeRequestEvent", "GatewayNodeInvokeRequest"],
  ["QuestionOption", "QuestionOption"],
  ["Question", "Question"],
  ["QuestionAnswers", "QuestionAnswers"],
  ["QuestionRecord", "QuestionRecord"],
  ["QuestionGetResult", "QuestionGetResult"],
  ["QuestionListResult", "QuestionListResult"],
  ["MessageReactionSummary", "MessageReactionSummary"],
  ["SessionReactionsListParams", "SessionReactionsListParams"],
  ["SessionReactionsSetParams", "SessionReactionsSetParams"],
  ["SessionReactionsListResult", "SessionReactionsListResult"],
  ["SessionReactionsSetResult", "SessionReactionsSetResult"],
  ["SessionReactionEvent", "SessionReactionEvent"],
  ["SessionObserverPlanProgress", "SessionObserverPlanProgress"],
  ["SessionObserverDigest", "SessionObserverDigest"],
  ["WorkerDesktopObserveParams", "WorkerDesktopObserveParams"],
  ["WorkerDesktopObserveResult", "WorkerDesktopObserveResult"],
  ["WorkerDesktopLaunchParams", "WorkerDesktopLaunchParams"],
  ["WorkerDesktopLaunchResult", "WorkerDesktopLaunchResult"],
  ["ProjectsListResult", "ProjectsListResult"],
  ["GitHubIdentityFacts", "GitHubIdentityFacts"],
  ["GitHubSelectedIdentity", "GitHubSelectedIdentity"],
  ["ToolsGitHubStatusParams", "ToolsGitHubStatusParams"],
  ["ToolsGitHubStatusResult", "ToolsGitHubStatusResult"],
  ["ToolsGitHubAuthorizeStartParams", "ToolsGitHubAuthorizeStartParams"],
  ["ToolsGitHubAuthorizeStartResult", "ToolsGitHubAuthorizeStartResult"],
  ["ToolsGitHubAuthorizePollParams", "ToolsGitHubAuthorizePollParams"],
  ["ToolsGitHubAuthorizePendingResult", "ToolsGitHubAuthorizePendingResult"],
  ["ToolsGitHubAuthorizeSlowDownResult", "ToolsGitHubAuthorizeSlowDownResult"],
  ["ToolsGitHubAuthorizeAccessDeniedResult", "ToolsGitHubAuthorizeAccessDeniedResult"],
  ["ToolsGitHubAuthorizeExpiredResult", "ToolsGitHubAuthorizeExpiredResult"],
  [
    "ToolsGitHubAuthorizeIncorrectDeviceCodeResult",
    "ToolsGitHubAuthorizeIncorrectDeviceCodeResult",
  ],
  ["ToolsGitHubAuthorizeNetworkErrorResult", "ToolsGitHubAuthorizeNetworkErrorResult"],
  ["ToolsGitHubAuthorizeFailedResult", "ToolsGitHubAuthorizeFailedResult"],
  ["ToolsGitHubAuthorizeSuccessResult", "ToolsGitHubAuthorizeSuccessResult"],
  ["ToolsGitHubAuthorizePollResult", "ToolsGitHubAuthorizePollResult"],
  ["ToolsGitHubAuthorizeCancelParams", "ToolsGitHubAuthorizeCancelParams"],
  ["ToolsGitHubAuthorizeCancelResult", "ToolsGitHubAuthorizeCancelResult"],
  ["SessionGitHubPublicationRequested", "SessionGitHubPublicationRequested"],
  ["SessionGitHubPublicationPublishing", "SessionGitHubPublicationPublishing"],
  ["SessionGitHubPublicationPublished", "SessionGitHubPublicationPublished"],
  ["SessionGitHubPublicationFailed", "SessionGitHubPublicationFailed"],
  ["SessionGitHubPublicationNeedsConfirmation", "SessionGitHubPublicationNeedsConfirmation"],
  ["SessionGitHubPublicationResult", "SessionGitHubPublicationResult"],
  ["TalkSessionCancelOutputResult", "TalkSessionCancelOutputResult"],
]);

const androidEnums: EnumSpec[] = [
  enumSpec("OpenClawCapability", "", [
    ["Canvas", "canvas"],
    ["Camera", "camera"],
    ["Sms", "sms"],
    ["Talk", "talk"],
    ["Location", "location"],
    ["Device", "device"],
    ["Notifications", "notifications"],
    ["System", "system"],
    ["Photos", "photos"],
    ["Contacts", "contacts"],
    ["Calendar", "calendar"],
    ["Motion", "motion"],
    ["CallLog", "callLog"],
    ["VoiceWake", "voiceWake"],
    ["MobileUI", "mobileUI"],
  ]),
  enumSpec("OpenClawCameraCommand", "camera.", [
    ["List", "list"],
    ["Snap", "snap"],
    ["Clip", "clip"],
  ]),
  enumSpec("OpenClawSmsCommand", "sms.", [
    ["Send", "send"],
    ["Search", "search"],
  ]),
  enumSpec("OpenClawTalkCommand", "talk.", [
    ["PttStart", "ptt.start"],
    ["PttStop", "ptt.stop"],
    ["PttCancel", "ptt.cancel"],
    ["PttOnce", "ptt.once"],
  ]),
  enumSpec("OpenClawLocationCommand", "location.", [["Get", "get"]]),
  enumSpec("OpenClawDeviceCommand", "device.", [
    ["Status", "status"],
    ["Info", "info"],
    ["Permissions", "permissions"],
    ["Health", "health"],
    ["Apps", "apps"],
  ]),
  enumSpec("OpenClawNotificationsCommand", "notifications.", [
    ["List", "list"],
    ["Actions", "actions"],
  ]),
  enumSpec("OpenClawSystemCommand", "system.", [["Notify", "notify"]]),
  enumSpec("OpenClawPhotosCommand", "photos.", [["Latest", "latest"]]),
  enumSpec("OpenClawContactsCommand", "contacts.", [
    ["Search", "search"],
    ["Add", "add"],
  ]),
  enumSpec("OpenClawCalendarCommand", "calendar.", [
    ["Events", "events"],
    ["Add", "add"],
  ]),
  enumSpec("OpenClawMotionCommand", "motion.", [
    ["Activity", "activity"],
    ["Pedometer", "pedometer"],
  ]),
  enumSpec("OpenClawCallLogCommand", "callLog.", [["Search", "search"]]),
  enumSpec("OpenClawMobileUiCommand", "mobile.ui.", [
    ["Observe", "observe"],
    ["Act", "act"],
  ]),
];

function enumSpec(
  name: string,
  namespacePrefix: string,
  values: Array<[name: string, suffix: string]>,
): EnumSpec {
  return {
    name,
    namespacePrefix,
    values: values.map(([caseName, suffix]) => ({
      name: caseName,
      rawValue: namespacePrefix + suffix,
    })),
  };
}

function literalValue(schema: JsonSchema): boolean | number | string | null | undefined {
  if ("const" in schema) {
    return schema.const;
  }
  return schema.enum?.length === 1 ? schema.enum[0] : undefined;
}

function kotlinLiteral(value: boolean | number | string | null): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

function emitEnum(spec: EnumSpec): string {
  const body = spec.values.map((value) => `  ${value.name}(${JSON.stringify(value.rawValue)}),`);
  if (spec.namespacePrefix) {
    body.push(
      "  ;",
      "",
      "  companion object {",
      `    const val NamespacePrefix: String = ${JSON.stringify(spec.namespacePrefix)}`,
      "  }",
    );
  }
  return [`enum class ${spec.name}(`, "  val rawValue: String,", ") {", ...body, "}"].join("\n");
}

function emitWireModels(): string[] {
  const selectedSchemas = new Map<JsonSchema, string>();
  const selectedSignatures = new Map<string, string>();
  for (const [schemaName, kotlinName] of schemaNames) {
    const schema = protocolSchemas[schemaName];
    if (!schema) {
      throw new Error(`Missing ProtocolSchemas.${schemaName}`);
    }
    selectedSchemas.set(schema, kotlinName);
    selectedSignatures.set(schemaSignature(schema), kotlinName);
  }

  const nestedModels = new Map<string, JsonSchema>();
  const unionVariants = new Map<
    string,
    { discriminator: string; literal: string; unionName: string }
  >();
  const discriminatedUnions = new Map<string, string>();
  for (const [schemaName, kotlinName] of schemaNames) {
    const schema = protocolSchemas[schemaName];
    const branches = schema?.oneOf ?? schema?.anyOf;
    if (!branches || branches.length < 2 || branches.some((branch) => branch.type !== "object")) {
      continue;
    }
    const discriminator = Object.keys(branches[0]?.properties ?? {}).find((property) =>
      branches.every(
        (branch) => typeof literalValue(branch.properties?.[property] ?? {}) === "string",
      ),
    );
    if (!discriminator) {
      continue;
    }
    discriminatedUnions.set(kotlinName, discriminator);
    for (const branch of branches) {
      const signature = schemaSignature(branch);
      const literal = literalValue(branch.properties?.[discriminator] ?? {}) as string;
      if (!selectedSignatures.has(signature)) {
        throw new Error(
          `${schemaName} variant ${JSON.stringify(literal)} must be selected for Kotlin generation`,
        );
      }
      unionVariants.set(signature, {
        discriminator,
        literal,
        unionName: kotlinName,
      });
    }
  }
  const kotlinType = (schema: JsonSchema, nestedName: string): string => {
    const selected = selectedSchemas.get(schema) ?? selectedSignatures.get(schemaSignature(schema));
    if (selected) {
      return selected;
    }
    const stringUnion = schema.anyOf?.map(literalValue);
    if (stringUnion?.length && stringUnion.every((value) => typeof value === "string")) {
      return "String";
    }
    if (schema.type === "string" || typeof schema.const === "string") {
      return "String";
    }
    if (schema.type === "integer") {
      return "Long";
    }
    if (schema.type === "number") {
      return "Double";
    }
    if (schema.type === "boolean") {
      return "Boolean";
    }
    if (schema.type === "array") {
      return `List<${kotlinType(schema.items ?? {}, `${nestedName}Item`)}>`;
    }
    if (schema.patternProperties) {
      const valueSchema = Object.values(schema.patternProperties)[0] ?? {};
      return `Map<String, ${kotlinType(valueSchema, `${nestedName}Value`)}>`;
    }
    if (schema.type === "object") {
      nestedModels.set(nestedName, schema);
      return nestedName;
    }
    return "JsonElement";
  };

  const emitModel = (name: string, schema: JsonSchema): string => {
    if (schema.type !== "object" || !schema.properties) {
      throw new Error(`${name} must remain an object schema for Kotlin generation`);
    }
    const required = new Set(schema.required ?? []);
    const variant = unionVariants.get(schemaSignature(schema));
    const fields = Object.entries(schema.properties)
      .filter(([wireName]) => wireName !== variant?.discriminator)
      .flatMap(([wireName, propertySchema]) => {
        const propertyName = lowerCamel(wireName);
        const type = kotlinType(propertySchema, `${name}${upperCamel(wireName)}`);
        const literal = literalValue(propertySchema);
        const optional = !required.has(wireName);
        const useLiteralDefault =
          literal !== undefined && (optional || typeof literal !== "boolean");
        const lines = [
          `  val ${propertyName}: ${type}${optional ? "?" : ""}${
            useLiteralDefault ? ` = ${kotlinLiteral(literal)}` : optional ? " = null" : ""
          },`,
        ];
        if (propertyName !== wireName) {
          lines.unshift(`  @SerialName(${JSON.stringify(wireName)})`);
        }
        return lines;
      });
    if (fields.length === 0 && variant) {
      return [
        `@SerialName(${JSON.stringify(variant.literal)})`,
        "@Serializable",
        `data object ${name} : ${variant.unionName}`,
      ].join("\n");
    }
    return [
      ...(variant ? [`@SerialName(${JSON.stringify(variant.literal)})`] : []),
      "@Serializable",
      `data class ${name}(`,
      ...fields,
      `)${variant ? ` : ${variant.unionName}` : ""}`,
    ].join("\n");
  };

  const emitUnion = (name: string, discriminator: string): string =>
    [
      "@OptIn(ExperimentalSerializationApi::class)",
      "@Serializable",
      `@JsonClassDiscriminator(${JSON.stringify(discriminator)})`,
      `sealed interface ${name}`,
    ].join("\n");

  const output: string[] = [];
  for (const [schemaName, kotlinName] of schemaNames) {
    const union = discriminatedUnions.get(kotlinName);
    output.push(
      union ? emitUnion(kotlinName, union) : emitModel(kotlinName, protocolSchemas[schemaName]!),
    );
  }
  for (const [nestedName, schema] of nestedModels) {
    if (!output.some((model) => model.startsWith(`@Serializable\ndata class ${nestedName}(`))) {
      output.push(emitModel(nestedName, schema));
    }
  }
  return output;
}

function emitGatewayCatalogEnum(name: string, values: readonly string[]): string {
  const seenNames = new Map<string, string>();
  const entries = values.map((rawValue) => {
    const caseName = upperCamel(rawValue);
    const previous = seenNames.get(caseName);
    if (previous) {
      throw new Error(
        `${name} case collision: ${previous} and ${rawValue} both map to ${caseName}`,
      );
    }
    seenNames.set(caseName, rawValue);
    return { name: caseName, rawValue };
  });
  return emitEnum({ name, values: entries });
}

export async function generateKotlinProtocol(repoRoot: string): Promise<Record<string, string>> {
  const gatewayEventSource = await fs.readFile(
    path.join(repoRoot, "src/gateway/server-methods-list.ts"),
    "utf8",
  );
  const gatewayEventConstants = await fs.readFile(
    path.join(repoRoot, "src/gateway/events.ts"),
    "utf8",
  );
  const gatewayEvents = Array.from(
    extractGatewayEventNames(gatewayEventSource, gatewayEventConstants),
  );
  const gatewayMethods = listCoreGatewayMethodNames();

  const gatewayContent = [
    "// Generated by scripts/protocol-gen-kotlin.ts — do not edit by hand.",
    "package ai.openclaw.app.gateway",
    "",
    "import kotlinx.serialization.ExperimentalSerializationApi",
    "import kotlinx.serialization.SerialName",
    "import kotlinx.serialization.Serializable",
    "import kotlinx.serialization.json.JsonClassDiscriminator",
    "import kotlinx.serialization.json.JsonElement",
    "",
    `const val GATEWAY_PROTOCOL_VERSION = ${PROTOCOL_VERSION}`,
    // Android consumes v3 message-only chat deltas and uses the N-1 node transport.
    `const val GATEWAY_MIN_PROTOCOL_VERSION = ${MIN_NODE_PROTOCOL_VERSION}`,
    "",
    ...emitWireModels().flatMap((model) => [model, ""]),
    emitGatewayCatalogEnum("GatewayMethod", gatewayMethods),
    "",
    emitGatewayCatalogEnum("GatewayEvent", gatewayEvents),
    "",
  ].join("\n");
  const constantsContent = [
    "// Generated by scripts/protocol-gen-kotlin.ts — do not edit by hand.",
    "package ai.openclaw.app.protocol",
    "",
    ...androidEnums.flatMap((spec) => [emitEnum(spec), ""]),
  ].join("\n");

  return {
    "ai/openclaw/app/gateway/GatewayProtocol.kt": gatewayContent,
    "ai/openclaw/app/protocol/OpenClawProtocolConstants.kt": constantsContent,
  };
}
