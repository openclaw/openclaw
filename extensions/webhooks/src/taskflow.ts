import type { TaskFlowWebhookTarget } from "./http.js";
import { toFlowView, toTaskView } from "./taskflow-actions.js";
import {
  applySkillHint,
  buildDefaultWebhookPrompt,
  normalizeJsonForState,
  renderOptionalTemplate,
  type WebhookDispatchContext,
} from "./template.js";

export { executeTaskFlowActionDispatch } from "./taskflow-actions.js";

export async function executeTaskFlowTemplateDispatch(params: {
  target: TaskFlowWebhookTarget;
  context: WebhookDispatchContext;
}): Promise<unknown> {
  const { target, context } = params;
  const taskflow = target.taskflow ?? {};
  const goal =
    renderOptionalTemplate(taskflow.goalTemplate, context) ??
    renderOptionalTemplate(target.prompt, context) ??
    buildDefaultWebhookPrompt(context);
  const flow = target.taskFlow.createManaged({
    controllerId: target.defaultControllerId,
    goal: applySkillHint(goal, target.skills),
    status: taskflow.status,
    notifyPolicy: taskflow.notifyPolicy,
    currentStep: taskflow.currentStep,
    stateJson: {
      source: "webhooks",
      routeId: target.routeId,
      ...(context.eventType ? { eventType: context.eventType } : {}),
      ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      payload: normalizeJsonForState(context.body),
    },
  });

  const runTask = taskflow.runTask;
  if (!runTask || runTask.enabled === false) {
    return {
      action: "taskflow_dispatch",
      flow: toFlowView(flow),
    };
  }

  const renderedTask =
    renderOptionalTemplate(runTask.taskTemplate, context) ??
    renderOptionalTemplate(target.prompt, context) ??
    buildDefaultWebhookPrompt(context);
  const runId =
    renderOptionalTemplate(runTask.runIdTemplate, context) ??
    context.idempotencyKey ??
    `${target.routeId}:${flow.flowId}`;
  const result = target.taskFlow.runTask({
    flowId: flow.flowId,
    runtime: runTask.runtime,
    sourceId: runTask.sourceId,
    childSessionKey: runTask.childSessionKey,
    parentTaskId: runTask.parentTaskId,
    agentId: runTask.agentId,
    runId,
    label: renderOptionalTemplate(runTask.labelTemplate, context),
    task: applySkillHint(renderedTask, target.skills),
    preferMetadata: runTask.preferMetadata,
    notifyPolicy: runTask.notifyPolicy,
    status: runTask.status,
  });

  return result.created
    ? {
        action: "taskflow_dispatch",
        flow: toFlowView(result.flow),
        task: toTaskView(result.task),
      }
    : {
        action: "taskflow_dispatch",
        flow: toFlowView(flow),
        taskCreated: false,
        reason: result.reason,
      };
}
