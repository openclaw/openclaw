import { isToolAllowedByPolicyName } from "./tool-policy-match.js";

export type GeeRuntimeToolPolicy = {
  allowedToolIds: string[];
  endpointIds: string[];
};

export function resolveGeeRuntimeToolPolicy(
  preparedFacts?: Record<string, unknown>,
): GeeRuntimeToolPolicy | undefined {
  if (!preparedFacts || Object.keys(preparedFacts).length === 0) {
    return undefined;
  }

  const endpointIds: string[] = [];
  const allowedToolIds = new Set<string>();
  for (const [endpointId, rawFact] of Object.entries(preparedFacts)) {
    const fact = readRequiredRecord(rawFact, endpointId, "preparedFacts");
    readLiteral(fact.kind, "gee-runtime-prepared-facts", endpointId, "kind");
    readLiteral(fact.version, 1, endpointId, "version");
    readLiteral(fact.hostMode, "gee-hosted", endpointId, "hostMode");

    const envelope = readRequiredRecord(fact.envelope, endpointId, "envelope");
    const tools = readRequiredRecord(envelope.tools, endpointId, "envelope.tools");
    readLiteral(tools.policy, "gee-authorized", endpointId, "envelope.tools.policy");
    for (const toolId of readStringArray(
      tools.allowedToolIds,
      endpointId,
      "envelope.tools.allowedToolIds",
    )) {
      allowedToolIds.add(toolId);
    }
    endpointIds.push(endpointId);
  }

  return {
    allowedToolIds: Array.from(allowedToolIds).toSorted((left, right) => left.localeCompare(right)),
    endpointIds: endpointIds.toSorted((left, right) => left.localeCompare(right)),
  };
}

export function resolveGeeRuntimeToolAllowlist(
  policy: GeeRuntimeToolPolicy | undefined,
  fallbackAllowlist?: string[],
): string[] | undefined {
  return policy ? policy.allowedToolIds : fallbackAllowlist;
}

export function isGeeRuntimeToolAllowed(
  policy: GeeRuntimeToolPolicy | undefined,
  toolName: string,
): boolean {
  if (!policy) {
    return true;
  }
  if (policy.allowedToolIds.length === 0) {
    return false;
  }
  return isToolAllowedByPolicyName(toolName, { allow: policy.allowedToolIds });
}

function readRequiredRecord(
  value: unknown,
  endpointId: string,
  fieldName: string,
): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throwInvalidPreparedFact(endpointId, fieldName);
}

function readStringArray(value: unknown, endpointId: string, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throwInvalidPreparedFact(endpointId, fieldName);
  }
  return value.map((entry) => readRequiredString(entry, endpointId, fieldName));
}

function readRequiredString(value: unknown, endpointId: string, fieldName: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throwInvalidPreparedFact(endpointId, fieldName);
}

function readLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  endpointId: string,
  fieldName: string,
): T {
  if (value === expected) {
    return expected;
  }
  throwInvalidPreparedFact(endpointId, fieldName);
}

function throwInvalidPreparedFact(endpointId: string, fieldName: string): never {
  throw new Error(
    `Gee-hosted OpenClaw endpoint "${endpointId}" has invalid prepared runtime fact "${fieldName}".`,
  );
}
