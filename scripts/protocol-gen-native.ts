import { ProtocolSchemas } from "../packages/gateway-protocol/src/schema/protocol-schemas.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../packages/gateway-protocol/src/version.js";
import { generateKotlinProtocol } from "./protocol-gen-kotlin.js";
import { generateSwiftProtocol } from "./protocol-gen-swift.js";

export type NativeProtocolLanguage = "swift" | "kotlin";

export async function generateNativeProtocol(
  root: string,
  language: NativeProtocolLanguage,
): Promise<Record<string, string>> {
  return language === "swift"
    ? { "GatewayModels.swift": generateSwiftProtocol() }
    : generateKotlinProtocol(root);
}

/** Check the schema contract independently of cached or previously generated files. */
export function assertNativeProtocolContract(
  language: NativeProtocolLanguage,
  output: Record<string, string>,
): void {
  const source =
    language === "swift"
      ? output["GatewayModels.swift"]
      : output["ai/openclaw/app/gateway/GatewayProtocol.kt"];
  if (!source) {
    throw new Error(`Missing ${language} protocol models`);
  }
  const levels = {
    GATEWAY_PROTOCOL_VERSION: PROTOCOL_VERSION,
    GATEWAY_MIN_PROTOCOL_VERSION:
      language === "swift" ? MIN_CLIENT_PROTOCOL_VERSION : MIN_NODE_PROTOCOL_VERSION,
    ...(language === "swift"
      ? { GATEWAY_MIN_NODE_PROTOCOL_VERSION: MIN_NODE_PROTOCOL_VERSION }
      : {}),
  };
  for (const [name, value] of Object.entries(levels)) {
    if (!new RegExp(`\\b${name} = ${value}\\b`).test(source)) {
      throw new Error(`${language} ${name} differs from the protocol version source`);
    }
  }
  if (language !== "swift") {
    return;
  }
  for (const [name, schema] of Object.entries(ProtocolSchemas)) {
    if (schema.type === "object" && !source.includes(`public struct ${name}:`)) {
      throw new Error(`Missing Swift model for ProtocolSchemas.${name}`);
    }
    const variants = schema.oneOf ?? schema.anyOf;
    if (!Array.isArray(variants) || variants.length < 2) {
      continue;
    }
    const values = variants.map((variant) => variant.const);
    if (!values.every((value) => typeof value === "string")) {
      continue;
    }
    const start = source.indexOf(`public enum ${name}: String, Codable, Sendable {`);
    const end = source.indexOf("\n}\n", start);
    const declaration = source.slice(start, end);
    if (start < 0 || values.some((value) => !declaration.includes(`= ${JSON.stringify(value)}`))) {
      throw new Error(`Swift enum ${name} differs from its schema literals`);
    }
  }
}
