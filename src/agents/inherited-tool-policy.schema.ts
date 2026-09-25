import { z } from "zod";
import { parseDelegatedToolParameterPolicy } from "./inherited-tool-parameters.schema.js";
import type { DelegatedToolParameterPolicy } from "./inherited-tool-parameters.types.js";
import { normalizeToolPolicyName } from "./tool-policy-shared.js";

const namesSchema = z.array(z.string().trim().min(1));
const clauseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("configured"),
    allow: namesSchema.optional(),
    deny: namesSchema.optional(),
    frozenAllow: z.literal(true).optional(),
  }),
  z.strictObject({ kind: z.literal("runtime"), allow: namesSchema }),
  z.strictObject({ kind: z.literal("execution"), allow: namesSchema }),
  z.strictObject({ kind: z.literal("restart-safe") }),
]);

export type InheritedToolPolicyClause = z.infer<typeof clauseSchema>;

/** Saved restrictions, independent of the tool catalog that happened to be available. */
export type InheritedToolPolicyV2 = {
  clauses: InheritedToolPolicyClause[];
  parameters: DelegatedToolParameterPolicy;
};

export type InheritedToolPolicySource = Readonly<{
  policy: InheritedToolPolicyV2;
  assertCurrent: () => void;
}>;

export type InheritedToolPolicySourceCapture = () => Promise<InheritedToolPolicySource>;

export type InheritedToolPolicyRef = {
  current?: InheritedToolPolicyV2;
  captureSource?: (
    policy: InheritedToolPolicyV2,
    assertCurrent: () => void,
  ) => Promise<InheritedToolPolicyV2>;
};

const policySchema = z.strictObject({
  clauses: z.array(clauseSchema),
  parameters: z.unknown(),
});
const MAX_INHERITED_TOOL_POLICY_BYTES = 64 * 1024;

function normalizeNames(names: readonly string[]): string[] {
  return [...new Set(names.map(normalizeToolPolicyName).filter(Boolean))].toSorted();
}

function normalizeClause(clause: InheritedToolPolicyClause): InheritedToolPolicyClause {
  if (clause.kind === "restart-safe") {
    return { kind: "restart-safe" };
  }
  if (clause.kind !== "configured") {
    return { kind: clause.kind, allow: normalizeNames(clause.allow) };
  }
  const allow = clause.allow && normalizeNames(clause.allow);
  const deny = clause.deny && normalizeNames(clause.deny);
  return {
    kind: "configured",
    ...(allow?.length ? { allow } : {}),
    ...(deny?.length ? { deny } : {}),
    ...(clause.frozenAllow ? { frozenAllow: true as const } : {}),
  };
}

function uniqueRecords<T>(records: readonly T[]): T[] {
  return [...new Map(records.map((record) => [JSON.stringify(record), record])).entries()]
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value);
}

/** Unknown saved clauses must never disappear into a legacy unrestricted fallback. */
export function parseInheritedToolPolicyV2(value: unknown): InheritedToolPolicyV2 {
  const parsed = policySchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_INHERITED_TOOL_POLICY_BYTES) {
    throw new Error("Delegated action restrictions exceed the supported saved policy size.");
  }
  const policy = {
    clauses: uniqueRecords(
      parsed.clauses
        .map(normalizeClause)
        .filter((clause) => clause.kind !== "configured" || clause.allow || clause.deny),
    ),
    parameters: parseDelegatedToolParameterPolicy(parsed.parameters),
  };
  if (Buffer.byteLength(JSON.stringify(policy)) > MAX_INHERITED_TOOL_POLICY_BYTES) {
    throw new Error("Delegated action restrictions exceed the supported saved policy size.");
  }
  return policy;
}

/** Merge independently accepted restrictions without growing duplicate turn checkpoints. */
export function conjoinInheritedToolPolicies(
  policies: readonly InheritedToolPolicyV2[],
): InheritedToolPolicyV2 {
  const parsed = policies.map(parseInheritedToolPolicyV2);
  return parseInheritedToolPolicyV2({
    clauses: uniqueRecords(parsed.flatMap((policy) => policy.clauses)),
    parameters: {
      fileTools: uniqueRecords(parsed.flatMap((policy) => policy.parameters.fileTools)),
      exec: uniqueRecords(parsed.flatMap((policy) => policy.parameters.exec)),
      sandbox: uniqueRecords(parsed.flatMap((policy) => policy.parameters.sandbox)),
      unsupported: uniqueRecords(parsed.flatMap((policy) => policy.parameters.unsupported)),
    },
  });
}
