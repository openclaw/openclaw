// Gateway Protocol tests cover native protocol levels.guard behavior.
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

/**
 * Cross-language guard for Gateway protocol version constants.
 *
 * Native Swift/Kotlin clients and dev smoke scripts cannot derive these values
 * from TypeScript at runtime, so this test keeps generated constants
 * and connect payloads aligned with the package source of truth.
 */

const swiftGeneratedPath = `${nativeProtocolOutputDirectories.swift}/GatewayModels.swift`;
beforeAll(() => prepareNativeProtocol());

/** Reads a repo-relative source file used by a native protocol guard. */
async function readRepoFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

/** Asserts a compatibility pattern exists in generated/native source text. */
function assertPattern(
  content: string,
  relativePath: string,
  pattern: RegExp,
  message: string,
): void {
  if (pattern.test(content)) {
    return;
  }
  throw new Error(`${relativePath}: ${message}`);
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
    const swiftGenerated = await readRepoFile(swiftGeneratedPath);

    assertPattern(
      swiftGenerated,
      swiftGeneratedPath,
      /public enum SessionApprovalEvent: Codable, Sendable \{/,
      "missing the generated SessionApprovalEvent union.",
    );
    assertPattern(
      swiftGenerated,
      swiftGeneratedPath,
      /case pending\(PendingSessionApprovalEvent\)/,
      "SessionApprovalEvent must decode pending transitions.",
    );
    assertPattern(
      swiftGenerated,
      swiftGeneratedPath,
      /case terminal\(TerminalSessionApprovalEvent\)/,
      "SessionApprovalEvent must decode terminal transitions.",
    );
  });

  it("emits the scope upgrade result as a discriminated Swift union", async () => {
    const swiftGenerated = await readRepoFile(swiftGeneratedPath);

    assertPattern(
      swiftGenerated,
      swiftGeneratedPath,
      /public enum ScopeUpgradeResult: Codable, Sendable \{/,
      "missing the generated ScopeUpgradeResult union.",
    );
    assertPattern(
      swiftGenerated,
      swiftGeneratedPath,
      /case approved\(ScopeUpgradeApproved\)/,
      "ScopeUpgradeResult must decode approved outcomes.",
    );
    assertPattern(
      swiftGenerated,
      swiftGeneratedPath,
      /case rejected\(ScopeUpgradeRejected\)/,
      "ScopeUpgradeResult must decode rejected outcomes.",
    );
    assertPattern(
      swiftGenerated,
      swiftGeneratedPath,
      /case expired\(ScopeUpgradeExpired\)/,
      "ScopeUpgradeResult must decode expired outcomes.",
    );
  });

  it("uses the min constant for native connect compatibility ranges", async () => {
    const swiftChannelPath = "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift";
    const swiftChannel = await readRepoFile(swiftChannelPath);
    const swiftRangePath =
      "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayConnectFailureBackoff.swift";
    const swiftRange = await readRepoFile(swiftRangePath);
    assertPattern(
      swiftRange,
      swiftRangePath,
      /if role == "node", clientMode == "node" \{\s+return GATEWAY_MIN_NODE_PROTOCOL_VERSION\s+\}\s+return GATEWAY_MIN_PROTOCOL_VERSION/,
      "node connections must use the node compatibility floor without changing operator clients.",
    );
    assertPattern(
      swiftChannel,
      swiftChannelPath,
      /var supportedProtocols: ClosedRange<Int> \{\s+Self\.minimumProtocolVersion\(\s+role: self\.connectOptions\?\.role \?\? "operator",\s+clientMode: self\.connectOptions\?\.clientMode \?\? "ui"\)\.\.\.GATEWAY_PROTOCOL_VERSION\s+\}/,
      "the shared range must use the configured role and mode through GATEWAY_PROTOCOL_VERSION.",
    );
    assertPattern(
      swiftChannel,
      swiftChannelPath,
      /let protocols = self\.supportedProtocols/,
      "connect params must use the shared supported protocol range.",
    );
    assertPattern(
      swiftChannel,
      swiftChannelPath,
      /"minProtocol": ProtoAnyCodable\(protocols\.lowerBound\)/,
      "connect params must advertise the role-specific minimum as minProtocol.",
    );
    assertPattern(
      swiftChannel,
      swiftChannelPath,
      /"maxProtocol": ProtoAnyCodable\(protocols\.upperBound\)/,
      "connect params must advertise GATEWAY_PROTOCOL_VERSION as maxProtocol.",
    );

    const watchPath = "apps/ios/WatchApp/Sources/WatchDirectNode.swift";
    const watch = await readRepoFile(watchPath);
    assertPattern(
      watch,
      watchPath,
      /minprotocol: GATEWAY_MIN_PROTOCOL_VERSION/,
      "Direct Watch HTTP connects must keep the current client protocol floor.",
    );
    assertPattern(
      watch,
      watchPath,
      /maxprotocol: GATEWAY_PROTOCOL_VERSION/,
      "Watch node connects must advertise GATEWAY_PROTOCOL_VERSION as maxProtocol.",
    );

    const swiftWizardPath = "apps/macos/Sources/OpenClawMacCLI/WizardCommand.swift";
    const swiftWizard = await readRepoFile(swiftWizardPath);
    assertPattern(
      swiftWizard,
      swiftWizardPath,
      /let client = GatewayChannelActor\([\s\S]*?connectOptions: GatewayConnectOptions\(\s+role: "operator",[\s\S]*?clientMode: "ui",/,
      "the wizard must use the shared operator client and its checked protocol range.",
    );
    assertPattern(
      swiftWizard,
      swiftWizardPath,
      /try await client\.connect\(\)/,
      "the wizard must connect through the shared protocol handshake.",
    );

    const androidPath = "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt";
    const android = await readRepoFile(androidPath);
    assertPattern(
      android,
      androidPath,
      /put\("minProtocol", JsonPrimitive\(GATEWAY_MIN_PROTOCOL_VERSION\)\)/,
      "connect params must advertise GATEWAY_MIN_PROTOCOL_VERSION as minProtocol.",
    );
    assertPattern(
      android,
      androidPath,
      /put\("maxProtocol", JsonPrimitive\(GATEWAY_PROTOCOL_VERSION\)\)/,
      "connect params must advertise GATEWAY_PROTOCOL_VERSION as maxProtocol.",
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
        assertPattern(
          enumSource,
          swiftGeneratedPath,
          new RegExp(`= ${JSON.stringify(value)}$`, "m"),
          `${name} must include the ${JSON.stringify(value)} literal.`,
        );
      }
    }
  });
});
