import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  nativeProtocolOutputDirectories,
  prepareNativeProtocol,
} from "../../../scripts/prepare-native-protocol.mjs";
import { ProtocolSchemas } from "./schema/protocol-schemas.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "./version.js";

const swiftGeneratedPath = `${nativeProtocolOutputDirectories.swift}/GatewayModels.swift`;
beforeAll(() => prepareNativeProtocol());

async function readRepoFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

// Native clients cannot derive these compatibility contracts from TypeScript at runtime.
async function assertPatterns(relativePath: string, patterns: readonly RegExp[]): Promise<void> {
  const content = await readRepoFile(relativePath);
  for (const pattern of patterns) {
    expect(content, relativePath).toMatch(pattern);
  }
}

function stringLiteralUnionValues(schema: unknown): string[] | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const candidate = schema as { anyOf?: unknown; oneOf?: unknown };
  const branches = candidate.oneOf ?? candidate.anyOf;
  if (!Array.isArray(branches) || branches.length === 0) {
    return undefined;
  }

  const values: string[] = [];
  for (const branch of branches) {
    if (!branch || typeof branch !== "object" || !("const" in branch)) {
      return undefined;
    }
    const value = branch.const;
    if (typeof value !== "string") {
      return undefined;
    }
    values.push(value);
  }
  return new Set(values).size === values.length ? values : undefined;
}

describe("native Gateway protocol levels", () => {
  it("keeps node and probe compatibility at N-1 without widening general clients", () => {
    expect(MIN_NODE_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION - 1);
    expect(MIN_PROBE_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION - 1);
    expect(MIN_CLIENT_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });

  it("emits the session approval event as a discriminated Swift union", async () => {
    await assertPatterns(swiftGeneratedPath, [
      /public enum SessionApprovalEvent: Codable, Sendable \{/,
      /case pending\(PendingSessionApprovalEvent\)/,
      /case terminal\(TerminalSessionApprovalEvent\)/,
    ]);
  });

  it("emits the scope upgrade result as a discriminated Swift union", async () => {
    await assertPatterns(swiftGeneratedPath, [
      /public enum ScopeUpgradeResult: Codable, Sendable \{/,
      /case approved\(ScopeUpgradeApproved\)/,
      /case rejected\(ScopeUpgradeRejected\)/,
      /case expired\(ScopeUpgradeExpired\)/,
    ]);
  });

  it("uses the min constant for native connect compatibility ranges", async () => {
    await assertPatterns(
      "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayConnectFailureBackoff.swift",
      [
        /if role == "node", clientMode == "node" \{\s+return GATEWAY_MIN_NODE_PROTOCOL_VERSION\s+\}\s+return GATEWAY_MIN_PROTOCOL_VERSION/,
      ],
    );
    await assertPatterns("apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift", [
      /var supportedProtocols: ClosedRange<Int> \{\s+Self\.minimumProtocolVersion\(\s+role: self\.connectOptions\?\.role \?\? "operator",\s+clientMode: self\.connectOptions\?\.clientMode \?\? "ui"\)\.\.\.GATEWAY_PROTOCOL_VERSION\s+\}/,
      /let protocols = self\.supportedProtocols/,
      /"minProtocol": ProtoAnyCodable\(protocols\.lowerBound\)/,
      /"maxProtocol": ProtoAnyCodable\(protocols\.upperBound\)/,
    ]);

    await assertPatterns("apps/ios/WatchApp/Sources/WatchDirectNode.swift", [
      /minprotocol: GATEWAY_MIN_PROTOCOL_VERSION/,
      /maxprotocol: GATEWAY_PROTOCOL_VERSION/,
    ]);

    await assertPatterns("apps/macos/Sources/OpenClawMacCLI/WizardCommand.swift", [
      /"minProtocol": ProtoAnyCodable\(GATEWAY_MIN_PROTOCOL_VERSION\)/,
      /"maxProtocol": ProtoAnyCodable\(GATEWAY_PROTOCOL_VERSION\)/,
    ]);

    await assertPatterns(
      "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt",
      [
        /put\("minProtocol", JsonPrimitive\(GATEWAY_MIN_PROTOCOL_VERSION\)\)/,
        /put\("maxProtocol", JsonPrimitive\(GATEWAY_PROTOCOL_VERSION\)\)/,
      ],
    );
  });

  it("emits named string-literal unions as Swift enums", async () => {
    const swiftGenerated = await readRepoFile(swiftGeneratedPath);

    for (const [name, schema] of Object.entries(ProtocolSchemas)) {
      const values = stringLiteralUnionValues(schema);
      if (!values) {
        continue;
      }

      const enumStart = `public enum ${name}: String, Codable, Sendable {`;
      const start = swiftGenerated.indexOf(enumStart);
      if (start < 0) {
        throw new Error(`${swiftGeneratedPath}: missing Swift enum for ${name}.`);
      }
      const end = swiftGenerated.indexOf("\n}\n", start);
      const enumSource = swiftGenerated.slice(start, end);
      for (const value of values) {
        expect(
          enumSource,
          `${swiftGeneratedPath}: ${name} must include the ${JSON.stringify(value)} literal.`,
        ).toMatch(new RegExp(`= ${JSON.stringify(value)}$`, "m"));
      }
    }
  });
});
