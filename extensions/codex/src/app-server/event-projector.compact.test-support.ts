import { vi, type Mock } from "vitest";
import {
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  forCurrentTurn,
  turnCompleted,
  type CodexAppServerEventProjector,
  type ProjectorNotification,
  type EmbeddedRunAttemptParams,
} from "./event-projector.test-harness.js";

export function notify(
  projector: CodexAppServerEventProjector,
  method: Parameters<typeof forCurrentTurn>[0],
  params: Record<string, unknown>,
) {
  return projector.handleNotification(forCurrentTurn(method, params));
}

export const result = (projector: CodexAppServerEventProjector) =>
  projector.buildResult(buildEmptyToolTelemetry());

export function message(id: string, value = "", phase?: string) {
  return { type: "agentMessage", id, text: value, ...(phase === undefined ? {} : { phase }) };
}

export const finalMessage = (id: string, value = "") => message(id, value, "final_answer");

export const text = (value: string) => [{ type: "text" as const, text: value }];

export const start = (projector: CodexAppServerEventProjector, item: unknown) =>
  notify(projector, "item/started", { item });

export const complete = (projector: CodexAppServerEventProjector, item: unknown) =>
  notify(projector, "item/completed", { item });

export const delta = (projector: CodexAppServerEventProjector, value: string, itemId = "msg-1") =>
  notify(projector, "item/agentMessage/delta", { itemId, delta: value });

export const finish = (projector: CodexAppServerEventProjector, items: unknown[] = []) =>
  projector.handleNotification(turnCompleted(items));

export function rawAssistant(
  projector: CodexAppServerEventProjector,
  value: string,
  fields: { id?: string; phase?: string } = {},
) {
  return notify(projector, "rawResponseItem/completed", {
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: value }],
      ...fields,
    },
  });
}

export function events(callback: Mock, stream: string, kind?: string) {
  return callback.mock.calls
    .map(([event]) => event)
    .filter((event) => event.stream === stream && (!kind || event.data.kind === kind));
}

export async function observe(
  overrides: Partial<EmbeddedRunAttemptParams> = {},
  options?: Parameters<typeof createProjector>[1],
) {
  const onAgentEvent = vi.fn();
  const projector = await createProjector(
    { ...(await createParams()), onAgentEvent, ...overrides },
    options,
  );
  return {
    projector,
    onAgentEvent,
    async send(this: void, ...notifications: ProjectorNotification[]) {
      for (const notification of notifications) {
        await projector.handleNotification(notification);
      }
    },
    events(this: void, stream: string, phase?: string) {
      return events(onAgentEvent, stream)
        .filter((event) => !phase || event.data.phase === phase)
        .map((event) => event.data);
    },
  };
}

export async function observePartial() {
  const onPartialReply = vi.fn();
  const { projector, onAgentEvent } = await observe({ onPartialReply });
  return { projector, onAgentEvent, onPartialReply };
}
