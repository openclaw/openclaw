import { z } from "zod";
import type { JsonValue } from "./template.js";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const nullableStringSchema = z.string().trim().min(1).nullable().optional();

const createFlowRequestSchema = z
  .object({
    action: z.literal("create_flow"),
    controllerId: z.string().trim().min(1).optional(),
    goal: z.string().trim().min(1),
    status: z.enum(["queued", "running", "waiting", "blocked"]).optional(),
    notifyPolicy: z.enum(["done_only", "state_changes", "silent"]).optional(),
    currentStep: nullableStringSchema,
    stateJson: jsonValueSchema.nullable().optional(),
    waitJson: jsonValueSchema.nullable().optional(),
  })
  .strict();

const getFlowRequestSchema = z
  .object({ action: z.literal("get_flow"), flowId: z.string().trim().min(1) })
  .strict();
const listFlowsRequestSchema = z.object({ action: z.literal("list_flows") }).strict();
const findLatestFlowRequestSchema = z.object({ action: z.literal("find_latest_flow") }).strict();
const resolveFlowRequestSchema = z
  .object({ action: z.literal("resolve_flow"), token: z.string().trim().min(1) })
  .strict();
const getTaskSummaryRequestSchema = z
  .object({ action: z.literal("get_task_summary"), flowId: z.string().trim().min(1) })
  .strict();

const setWaitingRequestSchema = z
  .object({
    action: z.literal("set_waiting"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    currentStep: nullableStringSchema,
    stateJson: jsonValueSchema.nullable().optional(),
    waitJson: jsonValueSchema.nullable().optional(),
    blockedTaskId: nullableStringSchema,
    blockedSummary: nullableStringSchema,
  })
  .strict();

const resumeFlowRequestSchema = z
  .object({
    action: z.literal("resume_flow"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    status: z.enum(["queued", "running"]).optional(),
    currentStep: nullableStringSchema,
    stateJson: jsonValueSchema.nullable().optional(),
  })
  .strict();

const finishFlowRequestSchema = z
  .object({
    action: z.literal("finish_flow"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    stateJson: jsonValueSchema.nullable().optional(),
  })
  .strict();

const failFlowRequestSchema = z
  .object({
    action: z.literal("fail_flow"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    stateJson: jsonValueSchema.nullable().optional(),
    blockedTaskId: nullableStringSchema,
    blockedSummary: nullableStringSchema,
  })
  .strict();

const requestCancelRequestSchema = z
  .object({
    action: z.literal("request_cancel"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

const cancelFlowRequestSchema = z
  .object({
    action: z.literal("cancel_flow"),
    flowId: z.string().trim().min(1),
  })
  .strict();

const runTaskRequestSchema = z
  .object({
    action: z.literal("run_task"),
    flowId: z.string().trim().min(1),
    runtime: z.enum(["subagent", "acp"]),
    sourceId: z.string().trim().min(1).optional(),
    childSessionKey: z.string().trim().min(1).optional(),
    parentTaskId: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    task: z.string().trim().min(1),
    preferMetadata: z.boolean().optional(),
    notifyPolicy: z.enum(["done_only", "state_changes", "silent"]).optional(),
    status: z.enum(["queued", "running"]).optional(),
    startedAt: z.number().int().nonnegative().optional(),
    lastEventAt: z.number().int().nonnegative().optional(),
    progressSummary: nullableStringSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.status !== "running" &&
      (value.startedAt !== undefined ||
        value.lastEventAt !== undefined ||
        value.progressSummary !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "status must be running when startedAt, lastEventAt, or progressSummary is provided",
        path: ["status"],
      });
    }
  });

export const webhookActionSchema = z.discriminatedUnion("action", [
  createFlowRequestSchema,
  getFlowRequestSchema,
  listFlowsRequestSchema,
  findLatestFlowRequestSchema,
  resolveFlowRequestSchema,
  getTaskSummaryRequestSchema,
  setWaitingRequestSchema,
  resumeFlowRequestSchema,
  finishFlowRequestSchema,
  failFlowRequestSchema,
  requestCancelRequestSchema,
  cancelFlowRequestSchema,
  runTaskRequestSchema,
]);

export type WebhookAction = z.infer<typeof webhookActionSchema>;

export function formatZodError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) {
    return "invalid request";
  }
  const path = firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : "";
  return `${path}${firstIssue.message}`;
}
