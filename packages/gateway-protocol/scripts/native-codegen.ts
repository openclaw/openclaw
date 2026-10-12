import { IsLiteralString, IsObject, IsUnion } from "typebox";
import { generateKotlinProtocol } from "../../../scripts/protocol-gen-kotlin.js";
import { generateSwiftProtocol } from "../../../scripts/protocol-gen-swift.js";
import { ProtocolSchemas } from "../src/schema/protocol-schemas.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../src/version.js";

type NativeProtocolLanguage = "swift" | "kotlin";

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
    if (IsObject(schema) && !source.includes(`public struct ${name}:`)) {
      throw new Error(`Missing Swift model for ProtocolSchemas.${name}`);
    }
    const variants = IsUnion(schema) ? schema.anyOf : undefined;
    if (!variants || variants.length < 2 || !variants.every(IsLiteralString)) {
      continue;
    }
    const values = variants.map((variant) => variant.const);
    const start = source.indexOf(`public enum ${name}: String, Codable, Sendable {`);
    const end = source.indexOf("\n}\n", start);
    const declaration = source.slice(start, end);
    const emittedValues = new Set(
      Array.from(declaration.matchAll(/^\s+case \w+ = (".*")$/gm), (match) => match[1]),
    );
    if (start < 0 || values.some((value) => !emittedValues.has(JSON.stringify(value)))) {
      throw new Error(`Swift enum ${name} differs from its schema literals`);
    }
  }
}
