import type { AnyAgentTool } from "../tools/common.js";
import type { ToolAuthorizationError } from "../tools/common.js";

export interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  tool: string;
  parameters: Record<string, unknown>;
  conditions?: WorkflowCondition[];
  onError?: WorkflowErrorHandler;
  onSuccess?: WorkflowSuccessHandler;
  timeout?: number;
  retryPolicy?: RetryPolicy;
}

export interface WorkflowCondition {
  type: "tool_result" | "parameter" | "context" | "custom";
  operator: "equals" | "contains" | "regex" | "greater_than" | "less_than" | "exists";
  field: string;
  value: unknown;
}

export interface WorkflowErrorHandler {
  strategy: "stop" | "continue" | "retry" | "fallback";
  fallbackStep?: string;
  maxRetries?: number;
  message?: string;
}

export interface WorkflowSuccessHandler {
  nextStep?: string;
  storeResult?: string;
  condition?: WorkflowCondition;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  version: string;
  steps: WorkflowStep[];
  variables: Record<string, unknown>;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface WorkflowExecutionContext {
  workflowId: string;
  stepResults: Map<string, unknown>;
  variables: Record<string, unknown>;
  context: Record<string, unknown>;
  currentStep: string;
  startTime: number;
  metadata: Record<string, unknown>;
}

export interface WorkflowResult {
  success: boolean;
  completedSteps: string[];
  failedSteps: string[];
  results: Map<string, unknown>;
  error?: string;
  executionTime: number;
}

export class WorkflowEngine {
  private workflows: Map<string, Workflow> = new Map();
  private tools: Map<string, AnyAgentTool> = new Map();
  private executions: Map<string, WorkflowExecutionContext> = new Map();

  constructor(tools: AnyAgentTool[]) {
    this.registerTools(tools);
  }

  /**
   * Register a new workflow
   */
  registerWorkflow(workflow: Workflow): void {
    this.workflows.set(workflow.id, workflow);
  }

  /**
   * Execute a workflow
   */
  async executeWorkflow(
    workflowId: string,
    initialContext: Record<string, unknown> = {},
    initialVariables: Record<string, unknown> = {}
  ): Promise<WorkflowResult> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const executionId = this.generateExecutionId();
    const context: WorkflowExecutionContext = {
      workflowId,
      stepResults: new Map(),
      variables: { ...workflow.variables, ...initialVariables },
      context: { ...workflow.context, ...initialContext },
      currentStep: workflow.steps[0]?.id || "",
      startTime: Date.now(),
      metadata: workflow.metadata
    };

    this.executions.set(executionId, context);

    try {
      await this.executeSteps(workflow, context);
      return this.createResult(context, true);
    } catch (error) {
      return this.createResult(context, false, error instanceof Error ? error.message : String(error));
    } finally {
      this.executions.delete(executionId);
    }
  }

  /**
   * Get execution status
   */
  getExecutionStatus(executionId: string): WorkflowExecutionContext | undefined {
    return this.executions.get(executionId);
  }

  /**
   * Stop a running workflow
   */
  stopWorkflow(executionId: string): boolean {
    const context = this.executions.get(executionId);
    if (context) {
      this.executions.delete(executionId);
      return true;
    }
    return false;
  }

  private async executeSteps(workflow: Workflow, context: WorkflowExecutionContext): Promise<void> {
    const stepMap = new Map(workflow.steps.map(step => [step.id, step]));
    let currentStepId = context.currentStep;

    while (currentStepId) {
      const step = stepMap.get(currentStepId);
      if (!step) {
        throw new Error(`Step not found: ${currentStepId}`);
      }

      // Check conditions
      if (!this.evaluateConditions(step.conditions || [], context)) {
        currentStepId = this.getNextStep(workflow, currentStepId, context);
        continue;
      }

      try {
        // Execute step with retry policy
        const result = await this.executeStepWithRetry(step, context);
        context.stepResults.set(currentStepId, result);

        // Handle success
        if (step.onSuccess) {
          const nextStep = this.handleSuccess(step.onSuccess, result, context);
          if (nextStep) {
            currentStepId = nextStep;
          } else {
            currentStepId = this.getNextStep(workflow, currentStepId, context);
          }
        } else {
          currentStepId = this.getNextStep(workflow, currentStepId, context);
        }

        context.currentStep = currentStepId;

      } catch (error) {
        if (step.onError) {
          const action = this.handleError(step.onError, error, context);
          if (action === "stop") {
            throw error;
          } else if (action === "fallback" && step.onError.fallbackStep) {
            currentStepId = step.onError.fallbackStep;
          } else if (action === "continue") {
            currentStepId = this.getNextStep(workflow, currentStepId, context);
          }
        } else {
          throw error;
        }
      }
    }
  }

  private async executeStepWithRetry(step: WorkflowStep, context: WorkflowExecutionContext): Promise<unknown> {
    const tool = this.tools.get(step.tool);
    if (!tool) {
      throw new Error(`Tool not found: ${step.tool}`);
    }

    const retryPolicy = step.retryPolicy || { maxAttempts: 1, backoffMs: 1000, backoffMultiplier: 2, retryableErrors: [] };
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
      try {
        return await this.executeTool(tool, step.parameters, context);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt === retryPolicy.maxAttempts || !this.isRetryableError(lastError, retryPolicy)) {
          throw lastError;
        }

        const delay = retryPolicy.backoffMs * Math.pow(retryPolicy.backoffMultiplier, attempt - 1);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private async executeTool(tool: AnyAgentTool, parameters: Record<string, unknown>, context: WorkflowExecutionContext): Promise<unknown> {
    // Substitute variables in parameters
    const resolvedParameters = this.substituteVariables(parameters, context);
    
    // Execute tool - AnyAgentTool extends AgentTool which has invoke method
    // For now, we'll use a type assertion since the interface should be compatible
    return await (tool as any).invoke(resolvedParameters, {
      agentId: context.context.agentId,
      sessionId: context.context.sessionId,
      // Add other context as needed
    } as any);
  }

  private substituteVariables(parameters: Record<string, unknown>, context: WorkflowExecutionContext): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(parameters)) {
      if (typeof value === "string" && value.startsWith("$")) {
        const varName = value.slice(1);
        result[key] = context.variables[varName] ?? context.context[varName] ?? context.stepResults.get(varName) ?? value;
      } else {
        result[key] = value;
      }
    }
    
    return result;
  }

  private evaluateConditions(conditions: WorkflowCondition[], context: WorkflowExecutionContext): boolean {
    return conditions.every(condition => this.evaluateCondition(condition, context));
  }

  private evaluateCondition(condition: WorkflowCondition, context: WorkflowExecutionContext): boolean {
    let value: unknown;
    
    switch (condition.type) {
      case "tool_result":
        value = context.stepResults.get(condition.field);
        break;
      case "parameter":
        value = context.variables[condition.field];
        break;
      case "context":
        value = context.context[condition.field];
        break;
      case "custom":
        // Custom conditions can be evaluated by plugins
        return true;
    }

    return this.compareValues(value, condition.operator, condition.value);
  }

  private compareValues(actual: unknown, operator: string, expected: unknown): boolean {
    switch (operator) {
      case "equals":
        return actual === expected;
      case "contains":
        return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
      case "regex":
        return typeof actual === "string" && typeof expected === "string" && new RegExp(expected).test(actual);
      case "greater_than":
        return typeof actual === "number" && typeof expected === "number" && actual > expected;
      case "less_than":
        return typeof actual === "number" && typeof expected === "number" && actual < expected;
      case "exists":
        return actual !== undefined && actual !== null;
      default:
        return false;
    }
  }

  private handleError(errorHandler: WorkflowErrorHandler, error: unknown, context: WorkflowExecutionContext): "stop" | "continue" | "retry" | "fallback" {
    return errorHandler.strategy;
  }

  private handleSuccess(successHandler: WorkflowSuccessHandler, result: unknown, context: WorkflowExecutionContext): string | null {
    if (successHandler.storeResult) {
      context.variables[successHandler.storeResult] = result;
    }
    
    if (successHandler.condition && !this.evaluateCondition(successHandler.condition, context)) {
      return null;
    }
    
    return successHandler.nextStep || null;
  }

  private getNextStep(workflow: Workflow, currentStepId: string, context: WorkflowExecutionContext): string {
    const currentIndex = workflow.steps.findIndex(step => step.id === currentStepId);
    if (currentIndex >= 0 && currentIndex < workflow.steps.length - 1) {
      return workflow.steps[currentIndex + 1].id;
    }
    return "";
  }

  private createResult(context: WorkflowExecutionContext, success: boolean, error?: string): WorkflowResult {
    return {
      success,
      completedSteps: Array.from(context.stepResults.keys()),
      failedSteps: success ? [] : [context.currentStep],
      results: context.stepResults,
      error,
      executionTime: Date.now() - context.startTime
    };
  }

  private registerTools(tools: AnyAgentTool[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  private generateExecutionId(): string {
    return `workflow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private isRetryableError(error: Error, retryPolicy: RetryPolicy): boolean {
    return retryPolicy.retryableErrors.some(retryableError => 
      error.message.includes(retryableError) || error.constructor.name === retryableError
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
