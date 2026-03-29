import { Message, Text, ImageFile, TextDelta, MessageDelta } from "../resources/beta/threads/messages.js";
import { RequestOptions } from "../internal/request-options.js";
import { Run, RunCreateParamsBase, Runs, RunSubmitToolOutputsParamsBase } from "../resources/beta/threads/runs/runs.js";
import { type ReadableStream } from "../internal/shim-types.js";
import { AssistantStreamEvent } from "../resources/beta/assistants.js";
import { RunStep, RunStepDelta, ToolCall, ToolCallDelta } from "../resources/beta/threads/runs/steps.js";
import { ThreadCreateAndRunParamsBase, Threads } from "../resources/beta/threads/threads.js";
import { BaseEvents, EventStream } from "./EventStream.js";
export interface AssistantStreamEvents extends BaseEvents {
    run: (run: Run) => void;
    messageCreated: (message: Message) => void;
    messageDelta: (message: MessageDelta, snapshot: Message) => void;
    messageDone: (message: Message) => void;
    runStepCreated: (runStep: RunStep) => void;
    runStepDelta: (delta: RunStepDelta, snapshot: Runs.RunStep) => void;
    runStepDone: (runStep: Runs.RunStep, snapshot: Runs.RunStep) => void;
    toolCallCreated: (toolCall: ToolCall) => void;
    toolCallDelta: (delta: ToolCallDelta, snapshot: ToolCall) => void;
    toolCallDone: (toolCall: ToolCall) => void;
    textCreated: (content: Text) => void;
    textDelta: (delta: TextDelta, snapshot: Text) => void;
    textDone: (content: Text, snapshot: Message) => void;
    imageFileDone: (content: ImageFile, snapshot: Message) => void;
    event: (event: AssistantStreamEvent) => void;
}
export type ThreadCreateAndRunParamsBaseStream = Omit<ThreadCreateAndRunParamsBase, 'stream'> & {
    stream?: true;
};
export type RunCreateParamsBaseStream = Omit<RunCreateParamsBase, 'stream'> & {
    stream?: true;
};
export type RunSubmitToolOutputsParamsStream = Omit<RunSubmitToolOutputsParamsBase, 'stream'> & {
    stream?: true;
};
export declare class AssistantStream extends EventStream<AssistantStreamEvents> implements AsyncIterable<AssistantStreamEvent> {
    #private;
    [Symbol.asyncIterator](): AsyncIterator<AssistantStreamEvent>;
    static fromReadableStream(stream: ReadableStream): AssistantStream;
    protected _fromReadableStream(readableStream: ReadableStream, options?: RequestOptions): Promise<Run>;
    toReadableStream(): ReadableStream;
    static createToolAssistantStream(runId: string, runs: Runs, params: RunSubmitToolOutputsParamsStream, options: RequestOptions | undefined): AssistantStream;
    protected _createToolAssistantStream(run: Runs, runId: string, params: RunSubmitToolOutputsParamsStream, options?: RequestOptions): Promise<Run>;
    static createThreadAssistantStream(params: ThreadCreateAndRunParamsBaseStream, thread: Threads, options?: RequestOptions): AssistantStream;
    static createAssistantStream(threadId: string, runs: Runs, params: RunCreateParamsBaseStream, options?: RequestOptions): AssistantStream;
    currentEvent(): AssistantStreamEvent | undefined;
    currentRun(): Run | undefined;
    currentMessageSnapshot(): Message | undefined;
    currentRunStepSnapshot(): Runs.RunStep | undefined;
    finalRunSteps(): Promise<Runs.RunStep[]>;
    finalMessages(): Promise<Message[]>;
    finalRun(): Promise<Run>;
    protected _createThreadAssistantStream(thread: Threads, params: ThreadCreateAndRunParamsBase, options?: RequestOptions): Promise<Run>;
    protected _createAssistantStream(run: Runs, threadId: string, params: RunCreateParamsBase, options?: RequestOptions): Promise<Run>;
    static accumulateDelta(acc: Record<string, any>, delta: Record<string, any>): Record<string, any>;
    protected _addRun(run: Run): Run;
    protected _threadAssistantStream(params: ThreadCreateAndRunParamsBase, thread: Threads, options?: RequestOptions): Promise<Run>;
    protected _runAssistantStream(threadId: string, runs: Runs, params: RunCreateParamsBase, options?: RequestOptions): Promise<Run>;
    protected _runToolAssistantStream(runId: string, runs: Runs, params: RunSubmitToolOutputsParamsStream, options?: RequestOptions): Promise<Run>;
}
//# sourceMappingURL=AssistantStream.d.ts.map