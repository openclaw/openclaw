import { z } from "zod";
import type { CommonWorkOperation } from "./common-work-adapter.js";

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const requiredStringList = z.array(boundedString(4000)).min(1).max(100);

const commonWorkRouteSchema = z
  .object({
    channelId: boundedString(240),
    threadId: boundedString(240),
    version: z.number().int().positive(),
  })
  .strict();

export const commonWorkOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("admit"),
      admission: z
        .object({
          workId: boundedString(120),
          requestKey: boundedString(240),
          requestDigest: boundedString(240),
          goal: boundedString(4000),
          objectiveDigest: boundedString(240),
          scope: requiredStringList,
          acceptanceCriteria: requiredStringList,
          reportingLeadAgentId: boundedString(120),
          ownerAgentId: boundedString(120),
          lane: z.enum(["common", "uni", "luke"]),
          sourceSessionKey: boundedString(240),
          callbackSessionKey: boundedString(240),
          userRoute: commonWorkRouteSchema,
          routeFamily: boundedString(240),
          routeSequence: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("correct"),
      expectedRevision: z.number().int().positive(),
      goal: boundedString(4000),
      objectiveDigest: boundedString(240),
      scope: requiredStringList,
      acceptanceCriteria: requiredStringList,
      reportingLeadAgentId: boundedString(120),
      source: z.enum(["user_correction", "agent_discovery", "separate_goal"]),
      correctionReceipt: boundedString(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("classify_discovery"),
      expectedRevision: z.number().int().positive(),
      discoveryId: boundedString(240),
      objective: boundedString(4000),
      classification: z.enum(["prerequisite_blocker", "separate_follow_up", "irrelevant"]),
      rationale: boundedString(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("approve_discovery"),
      expectedRevision: z.number().int().positive(),
      discoveryId: boundedString(240),
      approvalReceipt: boundedString(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("helper_return"),
      expectedRevision: z.number().int().positive(),
      helperAgentId: boundedString(120),
      targetAgentId: boundedString(120),
      receipt: boundedString(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("attach"),
      expectedRevision: z.number().int().positive(),
      executionId: boundedString(240),
      generation: z.number().int().positive(),
      sessionKey: boundedString(240),
      discoveredObjectiveId: boundedString(240).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("terminal"),
      expectedRevision: z.number().int().positive(),
      executionId: boundedString(240),
      generation: z.number().int().positive(),
      status: z.enum(["done", "failed", "cancelled"]),
      terminalReceipt: boundedString(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("callback"),
      expectedRevision: z.number().int().positive(),
      dedupeKey: boundedString(240),
      receipt: boundedString(500),
      targetSessionKey: boundedString(240),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delivery"),
      expectedRevision: z.number().int().positive(),
      route: commonWorkRouteSchema,
      receipt: boundedString(500),
    })
    .strict(),
]);

export function parseCommonWorkOperation(input: unknown): CommonWorkOperation {
  // SAFETY: The strict discriminated schema mirrors every CommonWorkOperation variant and rejects extras.
  return commonWorkOperationSchema.parse(input) as CommonWorkOperation;
}

export async function dispatchCommonWorkOperation<Result>(
  input: unknown,
  dispatch: (operation: CommonWorkOperation) => Result | Promise<Result>,
): Promise<Result> {
  return await dispatch(parseCommonWorkOperation(input));
}
