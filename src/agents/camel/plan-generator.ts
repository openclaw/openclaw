import { z } from "zod";
import { HEARTBEAT_TOKEN } from "../../auto-reply/tokens.js";

export interface PlanRef {
  ref: string;
  extract?: string;
}

export type PlanArgValue =
  | string
  | number
  | boolean
  | null
  | PlanArgValue[]
  | { [key: string]: PlanArgValue };

export type PlanArg = PlanArgValue | PlanRef;

export interface PlanStep {
  id: string;
  tool: string;
  args: Record<string, PlanArg>;
  assignTo?: string;
}

export interface ExecutionPlan {
  steps: PlanStep[];
  description: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** Compact parameter hints for the planner (e.g. "path: string (required), content: string (required)"). */
  parameterHints?: string;
}

type PlanModelCall = (input: {
  userPrompt: string;
  availableTools: ToolDefinition[];
  model: string;
}) => Promise<string>;

const PlanRefSchema = z
  .object({
    ref: z.string().min(1),
    extract: z.string().optional(),
  })
  .strict();

const PlanArgValueSchema: z.ZodType<PlanArgValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(PlanArgValueSchema),
    z.record(z.string(), PlanArgValueSchema),
  ]),
);

const PlanStepSchema = z
  .object({
    id: z.string().min(1),
    tool: z.string().min(1),
    args: z.record(z.string(), z.union([PlanRefSchema, PlanArgValueSchema])),
    assignTo: z.string().optional(),
  })
  .strict();

const ExecutionPlanSchema = z
  .object({
    description: z.string().min(1),
    steps: z.array(PlanStepSchema),
  })
  .strict();

const defaultPlanModelCall: PlanModelCall = async () => {
  throw new Error("No plan model caller configured.");
};

export function createPlanGenerator(modelCall: PlanModelCall = defaultPlanModelCall) {
  return async function generatePlan(
    userPrompt: string,
    availableTools: ToolDefinition[],
    model: string,
  ): Promise<ExecutionPlan> {
    let raw = "";
    try {
      raw = await modelCall({ userPrompt, availableTools, model });
      const trimmed = raw.trim();
      if (trimmed === HEARTBEAT_TOKEN || trimmed.startsWith(HEARTBEAT_TOKEN)) {
        return { description: "heartbeat", steps: [] };
      }
      const parsed = JSON.parse(trimmed) as unknown;
      return ExecutionPlanSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const truncated = raw.slice(0, 200);
      throw new Error(`Invalid execution plan: ${message}. Raw (truncated): ${truncated}`, {
        cause: error,
      });
    }
  };
}

export async function generatePlan(
  userPrompt: string,
  availableTools: ToolDefinition[],
  model: string,
): Promise<ExecutionPlan> {
  const generator = createPlanGenerator();
  return generator(userPrompt, availableTools, model);
}
