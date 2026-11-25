import fs from "node:fs/promises";
import path from "node:path";
import { IsLiteralString, IsUnion } from "typebox";
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
const readRepoFile = (file: string) => fs.readFile(path.join(process.cwd(), file), "utf8");
async function assertPatterns(file: string, patterns: RegExp[]) {
  const content = await readRepoFile(file);
  for (const pattern of patterns) {
    expect(content, file).toMatch(pattern);
  }
}

function stringLiteralUnionValues(schema: unknown): string[] | undefined {
  if (!IsUnion(schema) || schema.anyOf.length === 0 || !schema.anyOf.every(IsLiteralString)) {
    return undefined;
  }
  const values = schema.anyOf.map((branch) => branch.const);
  return new Set(values).size === values.length ? values : undefined;
}

// Cross-language clients cannot derive these compatibility floors at runtime.
describe("native Gateway protocol levels", () => {
  it("keeps node and probe compatibility at N-1 without widening general clients", () => {
    expect([
      MIN_NODE_PROTOCOL_VERSION,
      MIN_PROBE_PROTOCOL_VERSION,
      MIN_CLIENT_PROTOCOL_VERSION,
    ]).toEqual([PROTOCOL_VERSION - 1, PROTOCOL_VERSION - 1, PROTOCOL_VERSION]);
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
    await assertPatterns("apps/ios/WatchApp/Sources/WatchDirectNode.swift", [
      /minprotocol: GATEWAY_MIN_PROTOCOL_VERSION/,
      /maxprotocol: GATEWAY_PROTOCOL_VERSION/,
    ]);
    await assertPatterns("apps/macos/Sources/OpenClawMacCLI/WizardCommand.swift", [
      /let client = GatewayChannelActor\([\s\S]*?connectOptions: GatewayConnectOptions\(\s+role: "operator",[\s\S]*?clientMode: "ui",/,
      /try await client\.connect\(\)/,
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
      const start = swiftGenerated.indexOf(`public enum ${name}: String, Codable, Sendable {`);
      expect(start, `${swiftGeneratedPath}: missing Swift enum for ${name}`).toBeGreaterThanOrEqual(
        0,
      );
      const enumSource = swiftGenerated.slice(start, swiftGenerated.indexOf("\n}\n", start));
      for (const value of values) {
        expect(enumSource, `${name}: ${value}`).toMatch(
          new RegExp(`= ${JSON.stringify(value)}$`, "m"),
        );
      }
    }
  });
});
