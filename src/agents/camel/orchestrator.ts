import { requestApproval } from "./approval-flow.js";
import { createCapabilities } from "./capabilities.js";
import type { ExecutionPlan, PlanArg, PlanRef, ToolDefinition } from "./plan-generator.js";
import { SecurityPolicyEngine } from "./security-policy.js";
import { TaintTracker } from "./taint-tracker.js";
import type { ApprovalHandler, CaMeLConfig, CaMeLValue } from "./types.js";
import { SourceKind } from "./types.js";
import { createValue } from "./value.js";

type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

type PlanGenerator = (
  userPrompt: string,
  availableTools: ToolDefinition[],
  model: string,
) => Promise<ExecutionPlan>;

type QuarantinedExtractor = (
  instruction: string,
  untrustedData: CaMeLValue<string>,
  model: string,
) => Promise<CaMeLValue<string>>;

function unwrapValue(value: CaMeLValue): unknown {
  return value.raw;
}

export const CAMEL_NO_TOOLS_NEEDED = Symbol("camel_no_tools_needed");
export type CaMeLExecutionResult = CaMeLValue | typeof CAMEL_NO_TOOLS_NEEDED;

function isPlanRef(value: PlanArg): value is PlanRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "ref" && key !== "extract")) {
    return false;
  }
  const ref = (value as { ref?: unknown }).ref;
  const extract = (value as { extract?: unknown }).extract;
  return typeof ref === "string" && (extract === undefined || typeof extract === "string");
}

export class CaMeLOrchestrator {
  private config: CaMeLConfig;
  private policyEngine: SecurityPolicyEngine;
  private taintTracker: TaintTracker;
  private approvalHandler: ApprovalHandler;
  private planGenerator: PlanGenerator;
  private quarantinedExtractor: QuarantinedExtractor;

  constructor(params: {
    config: CaMeLConfig;
    policyEngine: SecurityPolicyEngine;
    taintTracker: TaintTracker;
    approvalHandler: ApprovalHandler;
    planGenerator: PlanGenerator;
    quarantinedExtractor: QuarantinedExtractor;
  }) {
    this.config = params.config;
    this.policyEngine = params.policyEngine;
    this.taintTracker = params.taintTracker;
    this.approvalHandler = params.approvalHandler;
    this.planGenerator = params.planGenerator;
    this.quarantinedExtractor = params.quarantinedExtractor;
  }

  async execute(
    userPrompt: string,
    availableTools: ToolDefinition[],
    toolExecutor: ToolExecutor,
    models?: { plannerModel?: string; quarantinedModel?: string },
  ): Promise<CaMeLExecutionResult> {
    if (!this.config.enabled) {
      return createValue(userPrompt, createCapabilities({ sources: [SourceKind.User] }));
    }

    const plannerModel = models?.plannerModel ?? "default";
    const quarantinedModel = models?.quarantinedModel ?? plannerModel;
    const plan = await this.planGenerator(userPrompt, availableTools, plannerModel);
    if (plan.steps.length === 0) {
      return CAMEL_NO_TOOLS_NEEDED;
    }
    const state = new Map<string, CaMeLValue>();
    let lastResult: CaMeLValue = createValue(
      userPrompt,
      createCapabilities({ sources: [SourceKind.User] }),
    );

    for (const step of plan.steps) {
      const wrappedArgs: Record<string, CaMeLValue> = {};

      for (const [argName, argValue] of Object.entries(step.args)) {
        if (!isPlanRef(argValue)) {
          wrappedArgs[argName] = createValue(
            argValue,
            createCapabilities({ sources: [SourceKind.Assistant] }),
          );
          continue;
        }

        const ref = state.get(argValue.ref);
        if (!ref) {
          throw new Error(`Unknown plan reference: ${argValue.ref}`);
        }

        if (!argValue.extract) {
          wrappedArgs[argName] = ref;
          continue;
        }

        const extracted = await this.quarantinedExtractor(
          argValue.extract,
          createValue(
            typeof ref.raw === "string" ? ref.raw : JSON.stringify(ref.raw, null, 2),
            ref.capabilities,
            [ref],
          ),
          quarantinedModel,
        );
        wrappedArgs[argName] = extracted;
      }

      const policyResult = this.policyEngine.checkPolicy(step.tool, wrappedArgs, []);

      if ("denied" in policyResult) {
        const approved = await requestApproval(
          { toolName: step.tool, reason: policyResult.reason },
          this.approvalHandler,
        );
        if (!approved) {
          throw new Error(`CaMeL blocked tool execution: ${policyResult.reason}`);
        }
      }

      const rawArgs = Object.fromEntries(
        Object.entries(wrappedArgs).map(([key, value]) => [key, unwrapValue(value)]),
      );
      const result = await toolExecutor(step.tool, rawArgs);
      const wrappedResult = this.taintTracker.wrapToolResult(step.tool, result);
      lastResult = wrappedResult;
      if (step.assignTo) {
        state.set(step.assignTo, wrappedResult);
      }
      if (step.id && step.id !== step.assignTo) {
        state.set(step.id, wrappedResult);
      }
    }

    return lastResult;
  }
}
