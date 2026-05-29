import { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStreamContract } from "../types.mjs";

//#region packages/llm-core/src/utils/event-stream.d.ts
declare class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue;
  private waiting;
  private done;
  private finalResultPromise;
  private resolveFinalResult;
  private isComplete;
  private extractResult;
  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R);
  push(event: T): void;
  end(result?: R): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
  result(): Promise<R>;
}
declare class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> implements AssistantMessageEventStreamContract {
  constructor();
}
/** Factory function for AssistantMessageEventStream (for use in extensions) */
declare function createAssistantMessageEventStream(): AssistantMessageEventStream;
//#endregion
export { AssistantMessageEventStream, EventStream, createAssistantMessageEventStream };