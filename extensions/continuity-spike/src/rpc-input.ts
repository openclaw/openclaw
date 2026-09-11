import {
  hasForbiddenControlCharacters,
  requireCondition as requireValue,
} from "./state-helpers.js";
import type { AdmittedOperation, Direction, OperationReceipt, StepCount } from "./types.js";

type Params = Record<string, unknown>;

export function shape(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): Params {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid-rpc-parameters",
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(
    Object.entries(descriptors).every(
      ([key, descriptor]) => allowed.includes(key) && "value" in descriptor,
    ),
    "invalid-rpc-fields",
  );
  requireValue(
    required.every((key) => Object.hasOwn(descriptors, key)),
    "missing-rpc-field",
  );
  const result: Params = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    result[key] = descriptor.value;
  }
  return result;
}
export function text(params: Params, key: string, maximum = 128): string {
  const value = params[key];
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      !hasForbiddenControlCharacters(value),
    `invalid-${key}`,
  );
  return value;
}
export function flag(params: Params, key: string): boolean {
  const value = params[key];
  requireValue(typeof value === "boolean", `invalid-${key}`);
  return value;
}
export function count(value: unknown): StepCount {
  requireValue(value === 1 || value === 2 || value === 3, "invalid-step-count");
  return value;
}
export function revision(value: unknown): number {
  requireValue(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "invalid-revision",
  );
  return value;
}
export function direction(value: unknown): Direction {
  requireValue(value === "A" || value === "B", "invalid-direction");
  return value;
}
export function operation(value: unknown): AdmittedOperation {
  const keys = [
    "id",
    "activityId",
    "destinationId",
    "runId",
    "decisionRevision",
    "direction",
    "step",
    "authorityGeneration",
    "attachmentGeneration",
    "expectedDestinationRevision",
    "hash",
  ];
  const p = shape(value, keys, keys);
  return {
    id: text(p, "id"),
    activityId: text(p, "activityId"),
    destinationId: text(p, "destinationId"),
    runId: text(p, "runId"),
    decisionRevision: revision(p.decisionRevision),
    direction: direction(p.direction),
    step: count(p.step),
    authorityGeneration: revision(p.authorityGeneration),
    attachmentGeneration: revision(p.attachmentGeneration),
    expectedDestinationRevision: revision(p.expectedDestinationRevision),
    hash: text(p, "hash"),
  };
}
export function receipt(value: unknown): OperationReceipt {
  const keys = [
    "operationId",
    "operationHash",
    "activityId",
    "destinationId",
    "destinationRevision",
    "outcome",
    "reason",
    "artifactId",
  ];
  const p = shape(value, keys, keys);
  requireValue(
    p.outcome === "succeeded" || p.outcome === "rejected" || p.outcome === "cancelled",
    "invalid-receipt-outcome",
  );
  requireValue(
    p.reason === "artifact-written" ||
      p.reason === "destination-revision-conflict" ||
      p.reason === "step-conflict" ||
      p.reason === "cancelled",
    "invalid-receipt-reason",
  );
  return {
    operationId: text(p, "operationId"),
    operationHash: text(p, "operationHash"),
    activityId: text(p, "activityId"),
    destinationId: text(p, "destinationId"),
    destinationRevision: revision(p.destinationRevision),
    outcome: p.outcome,
    reason: p.reason,
    artifactId: p.artifactId === null ? null : text(p, "artifactId"),
  };
}
