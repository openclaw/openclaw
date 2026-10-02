import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import { log as embeddedAgentLog } from "../embedded-agent-runner/logger.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

type PresentationStage =
  | "onAssistantMessageStart"
  | "onPartialReply"
  | "onReasoningStream"
  | "onReasoningEnd";

export class AgentHarnessProjectionSettlement<
  TParams extends AgentHarnessAttemptParamsV2 = AgentHarnessAttemptParamsV2,
> {
  readonly params: TParams;
  private stage: string | undefined;
  private readonly pending = new Map<Promise<void>, PresentationStage>();

  constructor(params: TParams, isActive: () => boolean, options: { label: string }) {
    const detach = <Args extends unknown[]>(
      stage: PresentationStage,
      callback: ((...args: Args) => unknown) | undefined,
    ): ((...args: Args) => void) | undefined =>
      callback
        ? (...args) => {
            if (!isActive()) {
              return;
            }
            // Reserve before invocation so reentrant callbacks retain source order.
            // Only presentation detaches; the terminal owner joins these promises.
            const completion = createDeferred();
            this.pending.set(completion.promise, stage);
            const settled = () => {
              this.pending.delete(completion.promise);
              completion.resolve();
            };
            const failed = (error: unknown) => {
              embeddedAgentLog.warn(`${options.label} ${stage} callback failed: ${String(error)}`);
              settled();
            };
            try {
              void Promise.resolve(callback(...args)).then(settled, failed);
            } catch (error) {
              failed(error);
            }
          }
        : undefined;
    this.params = {
      ...params,
      onAssistantMessageStart: detach("onAssistantMessageStart", params.onAssistantMessageStart),
      onPartialReply: detach("onPartialReply", params.onPartialReply),
      onReasoningStream: detach("onReasoningStream", params.onReasoningStream),
      onReasoningEnd: detach("onReasoningEnd", params.onReasoningEnd),
    };
  }

  get pendingStage(): string | undefined {
    return this.stage ?? this.pending.values().next().value;
  }

  async project<T>(stage: string, project: () => Promise<T>): Promise<T> {
    const previous = this.stage;
    this.stage = stage;
    try {
      return await project();
    } finally {
      this.stage = previous;
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending.keys());
    }
  }
}
