import {
  agentMessageDelta,
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  forCurrentTurn,
  turnCompleted,
  type EmbeddedRunAttemptParams,
} from "./event-projector.test-harness.js";

export function projectionEvents(projector: Awaited<ReturnType<typeof createProjector>>) {
  const notify = (method: Parameters<typeof forCurrentTurn>[0], params: Record<string, unknown>) =>
    projector.handleNotification(forCurrentTurn(method, params));
  return {
    notify,
    started: (item: Record<string, unknown>, params: Record<string, unknown> = {}) =>
      notify("item/started", { ...params, item }),
    completed: (item: Record<string, unknown>, params: Record<string, unknown> = {}) =>
      notify("item/completed", { ...params, item }),
    raw: (item: Record<string, unknown>) => notify("rawResponseItem/completed", { item }),
    complete: (items: unknown[] = []) => projector.handleNotification(turnCompleted(items)),
    delta: (...args: Parameters<typeof agentMessageDelta>) =>
      projector.handleNotification(agentMessageDelta(...args)),
    result: (telemetry = buildEmptyToolTelemetry()) => projector.buildResult(telemetry),
  };
}

export async function createProjection(...args: Parameters<typeof createProjector>) {
  const projector = await createProjector(...args);
  return { projector, events: projectionEvents(projector) };
}

export async function createConfiguredProjection(
  overrides: Partial<EmbeddedRunAttemptParams>,
  options?: Parameters<typeof createProjector>[1],
) {
  return createProjection({ ...(await createParams()), ...overrides }, options);
}
