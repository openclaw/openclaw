export type InterruptibleToolCall = { toolCallId: string; toolName: string };

export type ToolInterruptionStatus = {
  interruptible: InterruptibleToolCall[];
  blocked: InterruptibleToolCall[];
};

export type ToolInterruptionResult = {
  status: "interrupted" | "idle" | "blocked";
  tools: InterruptibleToolCall[];
};

export const USER_TOOL_INTERRUPTION_MESSAGE = "Interrupted by the user to send a pending message.";

export class ToolInterruptedByUser extends Error {
  constructor() {
    super(USER_TOOL_INTERRUPTION_MESSAGE);
    this.name = "ToolInterruptedByUser";
  }
}

/** Tracks only admitted call lifetimes; interruption never reaches a later call or the run. */
export class ToolInterruptions {
  private readonly calls = new Set<InterruptibleToolCall & { controller?: AbortController }>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  register(call: { id: string; name: string }, supported: boolean, runSignal?: AbortSignal) {
    const controller = supported ? new AbortController() : undefined;
    const entry: InterruptibleToolCall & { controller?: AbortController } = {
      toolCallId: call.id,
      toolName: call.name,
    };
    this.calls.add(entry);
    this.publish();
    return {
      ready: (safe: boolean) => {
        if (safe) {
          entry.controller = controller;
          this.publish();
        }
      },
      signal: controller
        ? runSignal
          ? AbortSignal.any([runSignal, controller.signal])
          : controller.signal
        : runSignal,
      get interrupted() {
        return controller?.signal.aborted === true;
      },
      dispose: () => {
        if (this.calls.delete(entry)) {
          this.publish();
        }
      },
    };
  }

  status(): ToolInterruptionStatus {
    const result: ToolInterruptionStatus = { interruptible: [], blocked: [] };
    for (const { controller, toolCallId, toolName } of this.calls) {
      result[controller ? "interruptible" : "blocked"].push({ toolCallId, toolName });
    }
    return result;
  }

  interrupt(): ToolInterruptionResult {
    const { interruptible, blocked } = this.status();
    if (blocked.length > 0) {
      return { status: "blocked", tools: blocked };
    }
    for (const { controller } of this.calls) {
      controller?.abort(new ToolInterruptedByUser());
    }
    return { status: interruptible.length ? "interrupted" : "idle", tools: interruptible };
  }
}
