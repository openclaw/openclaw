import { partialParse } from '../_vendor/partial-json-parser/parser';
import {
  APIUserAbortError,
  ContentFilterFinishReasonError,
  LengthFinishReasonError,
  OpenAIError,
} from '../error';
import OpenAI from '../index';
import { RequestOptions } from '../internal/request-options';
import { type ReadableStream } from '../internal/shim-types';
import {
  AutoParseableResponseFormat,
  hasAutoParseableInput,
  isAutoParsableResponseFormat,
  isAutoParsableTool,
  isChatCompletionFunctionTool,
  maybeParseChatCompletion,
  shouldParseToolCall,
} from '../lib/parser';
import { ChatCompletionFunctionTool, ParsedChatCompletion } from '../resources/chat/completions';
import {
  ChatCompletionTokenLogprob,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionCreateParams,
  type ChatCompletionCreateParamsBase,
  type ChatCompletionCreateParamsStreaming,
  type ChatCompletionRole,
} from '../resources/chat/completions/completions';
import { Stream } from '../streaming';
import {
  AbstractChatCompletionRunner,
  type AbstractChatCompletionRunnerEvents,
} from './AbstractChatCompletionRunner';

export interface ContentDeltaEvent {
  delta: string;
  snapshot: string;
  parsed: unknown | null;
}

export interface ContentDoneEvent<ParsedT = null> {
  content: string;
  parsed: ParsedT | null;
}

export interface RefusalDeltaEvent {
  delta: string;
  snapshot: string;
}

export interface RefusalDoneEvent {
  refusal: string;
}

export interface FunctionToolCallArgumentsDeltaEvent {
  name: string;

  index: number;

  arguments: string;

  parsed_arguments: unknown;

  arguments_delta: string;
}

export interface FunctionToolCallArgumentsDoneEvent {
  name: string;

  index: number;

  arguments: string;

  parsed_arguments: unknown;
}

export interface LogProbsContentDeltaEvent {
  content: Array<ChatCompletionTokenLogprob>;
  snapshot: Array<ChatCompletionTokenLogprob>;
}

export interface LogProbsContentDoneEvent {
  content: Array<ChatCompletionTokenLogprob>;
}

export interface LogProbsRefusalDeltaEvent {
  refusal: Array<ChatCompletionTokenLogprob>;
  snapshot: Array<ChatCompletionTokenLogprob>;
}

export interface LogProbsRefusalDoneEvent {
  refusal: Array<ChatCompletionTokenLogprob>;
}

export interface ChatCompletionStreamEvents<ParsedT = null> extends AbstractChatCompletionRunnerEvents {
  content: (contentDelta: string, contentSnapshot: string) => void;
  chunk: (chunk: ChatCompletionChunk, snapshot: ChatCompletionSnapshot) => void;

  'content.delta': (props: ContentDeltaEvent) => void;
  'content.done': (props: ContentDoneEvent<ParsedT>) => void;

  'refusal.delta': (props: RefusalDeltaEvent) => void;
  'refusal.done': (props: RefusalDoneEvent) => void;

  'tool_calls.function.arguments.delta': (props: FunctionToolCallArgumentsDeltaEvent) => void;
  'tool_calls.function.arguments.done': (props: FunctionToolCallArgumentsDoneEvent) => void;

  'logprobs.content.delta': (props: LogProbsContentDeltaEvent) => void;
  'logprobs.content.done': (props: LogProbsContentDoneEvent) => void;

  'logprobs.refusal.delta': (props: LogProbsRefusalDeltaEvent) => void;
  'logprobs.refusal.done': (props: LogProbsRefusalDoneEvent) => void;
}

export type ChatCompletionStreamParams = Omit<ChatCompletionCreateParamsBase, 'stream'> & {
  stream?: true;
};

interface ChoiceEventState {
  content_done: boolean;
  refusal_done: boolean;
  logprobs_content_done: boolean;
  logprobs_refusal_done: boolean;
  current_tool_call_index: number | null;
  done_tool_calls: Set<number>;
}

export class ChatCompletionStream<ParsedT = null>
  extends AbstractChatCompletionRunner<ChatCompletionStreamEvents<ParsedT>, ParsedT>
  implements AsyncIterable<ChatCompletionChunk>
{
  #params: ChatCompletionCreateParams | null;
  #choiceEventStates: ChoiceEventState[];
  #currentChatCompletionSnapshot: ChatCompletionSnapshot | undefined;

  constructor(params: ChatCompletionCreateParams | null) {
    super();
    this.#params = params;
    this.#choiceEventStates = [];
  }

  get currentChatCompletionSnapshot(): ChatCompletionSnapshot | undefined {
    return this.#currentChatCompletionSnapshot;
  }

  /**
   * Intended for use on the frontend, consuming a stream produced with
   * `.toReadableStream()` on the backend.
   *
   * Note that messages sent to the model do not appear in `.on('message')`
   * in this context.
   */
  static fromReadableStream(stream: ReadableStream): ChatCompletionStream<null> {
    const runner = new ChatCompletionStream(null);
    runner._run(() => runner._fromReadableStream(stream));
    return runner;
  }

  static createChatCompletion<ParsedT>(
    client: OpenAI,
    params: ChatCompletionStreamParams,
    options?: RequestOptions,
  ): ChatCompletionStream<ParsedT> {
    const runner = new ChatCompletionStream<ParsedT>(params as ChatCompletionCreateParamsStreaming);
    runner._run(() =>
      runner._runChatCompletion(
        client,
        { ...params, stream: true },
        { ...options, headers: { ...options?.headers, 'X-Stainless-Helper-Method': 'stream' } },
      ),
    );
    return runner;
  }

  #beginRequest() {
    if (this.ended) return;
    this.#currentChatCompletionSnapshot = undefined;
  }

  #getChoiceEventState(choice: ChatCompletionSnapshot.Choice): ChoiceEventState {
    let state = this.#choiceEventStates[choice.index];
    if (state) {
      return state;
    }

    state = {
      content_done: false,
      refusal_done: false,
      logprobs_content_done: false,
      logprobs_refusal_done: false,
      done_tool_calls: new Set(),
      current_tool_call_index: null,
    };
    this.#choiceEventStates[choice.index] = state;
    return state;
  }

  #addChunk(this: ChatCompletionStream<ParsedT>, chunk: ChatCompletionChunk) {
    if (this.ended) return;

    const completion = this.#accumulateChatCompletion(chunk);
    this._emit('chunk', chunk, completion);

    for (const choice of chunk.choices) {
      const choiceSnapshot = completion.choices[choice.index]!;

      if (
        choice.delta.content != null &&
        choiceSnapshot.message?.role === 'assistant' &&
        choiceSnapshot.message?.content
      ) {
        this._emit('content', choice.delta.content, choiceSnapshot.message.content);
        this._emit('content.delta', {
          delta: choice.delta.content,
          snapshot: choiceSnapshot.message.content,
          parsed: choiceSnapshot.message.parsed,
        });
      }

      if (
        choice.delta.refusal != null &&
        choiceSnapshot.message?.role === 'assistant' &&
        choiceSnapshot.message?.refusal
      ) {
        this._emit('refusal.delta', {
          delta: choice.delta.refusal,
          snapshot: choiceSnapshot.message.refusal,
        });
      }

      if (choice.logprobs?.content != null && choiceSnapshot.message?.role === 'assistant') {
        this._emit('logprobs.content.delta', {
          content: choice.logprobs?.content,
          snapshot: choiceSnapshot.logprobs?.content ?? [],
        });
      }

      if (choice.logprobs?.refusal != null && choiceSnapshot.message?.role === 'assistant') {
        this._emit('logprobs.refusal.delta', {
          refusal: choice.logprobs?.refusal,
          snapshot: choiceSnapshot.logprobs?.refusal ?? [],
        });
      }

      const state = this.#getChoiceEventState(choiceSnapshot);

      if (choiceSnapshot.finish_reason) {
        this.#emitContentDoneEvents(choiceSnapshot);

        if (state.current_tool_call_index != null) {
          this.#emitToolCallDoneEvent(choiceSnapshot, state.current_tool_call_index);
        }
      }

      for (const toolCall of choice.delta.tool_calls ?? []) {
        if (state.current_tool_call_index !== toolCall.index) {
          this.#emitContentDoneEvents(choiceSnapshot);

          // new tool call started, the previous one is done
          if (state.current_tool_call_index != null) {
            this.#emitToolCallDoneEvent(choiceSnapshot, state.current_tool_call_index);
          }
        }

        state.current_tool_call_index = toolCall.index;
      }

      for (const toolCallDelta of choice.delta.tool_calls ?? []) {
        const toolCallSnapshot = choiceSnapshot.message.tool_calls?.[toolCallDelta.index];
        if (!toolCallSnapshot?.type) {
          continue;
        }

        if (toolCallSnapshot?.type === 'function') {
          this._emit('tool_calls.function.arguments.delta', {
            name: toolCallSnapshot.function?.name,
            index: toolCallDelta.index,
            arguments: toolCallSnapshot.function.arguments,
            parsed_arguments: toolCallSnapshot.function.parsed_arguments,
            arguments_delta: toolCallDelta.function?.arguments ?? '',
          });
        } else {
          assertNever(toolCallSnapshot?.type);
        }
      }
    }
  }

  #emitToolCallDoneEvent(choiceSnapshot: ChatCompletionSnapshot.Choice, toolCallIndex: number) {
    const state = this.#getChoiceEventState(choiceSnapshot);
    if (state.done_tool_calls.has(toolCallIndex)) {
      // we've already fired the done event
      return;
    }

    const toolCallSnapshot = choiceSnapshot.message.tool_calls?.[toolCallIndex];
    if (!toolCallSnapshot) {
      throw new Error('no tool call snapshot');
    }
    if (!toolCallSnapshot.type) {
      throw new Error('tool call snapshot missing `type`');
    }

    if (toolCallSnapshot.type === 'function') {
      const inputTool = this.#params?.tools?.find(
        (tool) => isChatCompletionFunctionTool(tool) && tool.function.name === toolCallSnapshot.function.name,
      ) as ChatCompletionFunctionTool | undefined; // TS doesn't narrow based on isChatCompletionTool

      this._emit('tool_calls.function.arguments.done', {
        name: toolCallSnapshot.function.name,
        index: toolCallIndex,
        arguments: toolCallSnapshot.function.arguments,
        parsed_arguments:
          isAutoParsableTool(inputTool) ? inputTool.$parseRaw(toolCallSnapshot.function.arguments)
          : inputTool?.function.strict ? JSON.parse(toolCallSnapshot.function.arguments)
          : null,
      });
    } else {
      assertNever(toolCallSnapshot.type);
    }
  }

  #emitContentDoneEvents(choiceSnapshot: ChatCompletionSnapshot.Choice) {
    const state = this.#getChoiceEventState(choiceSnapshot);

    if (choiceSnapshot.message.content && !state.content_done) {
      state.content_done = true;

      const responseFormat = this.#getAutoParseableResponseFormat();

      this._emit('content.done', {
        content: choiceSnapshot.message.content,
        parsed: responseFormat ? responseFormat.$parseRaw(choiceSnapshot.message.content) : (null as any),
      });
    }

    if (choiceSnapshot.message.refusal && !state.refusal_done) {
      state.refusal_done = true;

      this._emit('refusal.done', { refusal: choiceSnapshot.message.refusal });
    }

    if (choiceSnapshot.logprobs?.content && !state.logprobs_content_done) {
      state.logprobs_content_done = true;

      this._emit('logprobs.content.done', { content: choiceSnapshot.logprobs.content });
    }

    if (choiceSnapshot.logprobs?.refusal && !state.logprobs_refusal_done) {
      state.logprobs_refusal_done = true;

      this._emit('logprobs.refusal.done', { refusal: choiceSnapshot.logprobs.refusal });
    }
  }

  #endRequest(): ParsedChatCompletion<ParsedT> {
    if (this.ended) {
      throw new OpenAIError(`stream has ended, this shouldn't happen`);
    }
    const snapshot = this.#currentChatCompletionSnapshot;
    if (!snapshot) {
      throw new OpenAIError(`request ended without sending any chunks`);
    }
    this.#currentChatCompletionSnapshot = undefined;
    this.#choiceEventStates = [];
    return finalizeChatCompletion(snapshot, this.#params);
  }

  protected override async _createChatCompletion(
    client: OpenAI,
    params: ChatCompletionCreateParams,
    options?: RequestOptions,
  ): Promise<ParsedChatCompletion<ParsedT>> {
    super._createChatCompletion;
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) this.controller.abort();
      signal.addEventListener('abort', () => this.controller.abort());
    }
    this.#beginRequest();

    const stream = await client.chat.completions.create(
      { ...params, stream: true },
      { ...options, signal: this.controller.signal },
    );
    this._connected();
    for await (const chunk of stream) {
      this.#addChunk(chunk);
    }
    if (stream.controller.signal?.aborted) {
      throw new APIUserAbortError();
    }
    return this._addChatCompletion(this.#endRequest());
  }

  protected async _fromReadableStream(
    readableStream: ReadableStream,
    options?: RequestOptions,
  ): Promise<ChatCompletion> {
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) this.controller.abort();
      signal.addEventListener('abort', () => this.controller.abort());
    }
    this.#beginRequest();
    this._connected();
    const stream = Stream.fromReadableStream<ChatCompletionChunk>(readableStream, this.controller);
    let chatId;
    for await (const chunk of stream) {
      if (chatId && chatId !== chunk.id) {
        // A new request has been made.
        this._addChatCompletion(this.#endRequest());
      }

      this.#addChunk(chunk);
      chatId = chunk.id;
    }
    if (stream.controller.signal?.aborted) {
      throw new APIUserAbortError();
    }
    return this._addChatCompletion(this.#endRequest());
  }

  #getAutoParseableResponseFormat(): AutoParseableResponseFormat<ParsedT> | null {
    const responseFormat = this.#params?.response_format;
    if (isAutoParsableResponseFormat<ParsedT>(responseFormat)) {
      return responseFormat;
    }

    return null;
  }

  #accumulateChatCompletion(chunk: ChatCompletionChunk): ChatCompletionSnapshot {
    let snapshot = this.#currentChatCompletionSnapshot;
    const { choices, ...rest } = chunk;
    if (!snapshot) {
      snapshot = this.#currentChatCompletionSnapshot = {
        ...rest,
        choices: [],
      };
    } else {
      Object.assign(snapshot, rest);
    }

    for (const { delta, finish_reason, index, logprobs = null, ...other } of chunk.choices) {
      let choice = snapshot.choices[index];
      if (!choice) {
        choice = snapshot.choices[index] = { finish_reason, index, message: {}, logprobs, ...other };
      }

      if (logprobs) {
        if (!choice.logprobs) {
          choice.logprobs = Object.assign({}, logprobs);
        } else {
          const { content, refusal, ...rest } = logprobs;
          assertIsEmpty(rest);
          Object.assign(choice.logprobs, rest);

          if (content) {
            choice.logprobs.content ??= [];
            choice.logprobs.content.push(...content);
          }

          if (refusal) {
            choice.logprobs.refusal ??= [];
            choice.logprobs.refusal.push(...refusal);
          }
        }
      }

      if (finish_reason) {
        choice.finish_reason = finish_reason;

        if (this.#params && hasAutoParseableInput(this.#params)) {
          if (finish_reason === 'length') {
            throw new LengthFinishReasonError();
          }

          if (finish_reason === 'content_filter') {
            throw new ContentFilterFinishReasonError();
          }
        }
      }

      Object.assign(choice, other);

      if (!delta) continue; // Shouldn't happen; just in case.

      const { content, refusal, function_call, role, tool_calls, ...rest } = delta;
      assertIsEmpty(rest);
      Object.assign(choice.message, rest);

      if (refusal) {
        choice.message.refusal = (choice.message.refusal || '') + refusal;
      }

      if (role) choice.message.role = role;
      if (function_call) {
        if (!choice.message.function_call) {
          choice.message.function_call = function_call;
        } else {
          if (function_call.name) choice.message.function_call.name = function_call.name;
          if (function_call.arguments) {
            choice.message.function_call.arguments ??= '';
            choice.message.function_call.arguments += function_call.arguments;
          }
        }
      }
      if (content) {
        choice.message.content = (choice.message.content || '') + content;

        if (!choice.message.refusal && this.#getAutoParseableResponseFormat()) {
          choice.message.parsed = partialParse(choice.message.content);
        }
      }

      if (tool_calls) {
        if (!choice.message.tool_calls) choice.message.tool_calls = [];

        for (const { index, id, type, function: fn, ...rest } of tool_calls) {
          const tool_call = (choice.message.tool_calls[index] ??=
            {} as ChatCompletionSnapshot.Choice.Message.ToolCall);
          Object.assign(tool_call, rest);
          if (id) tool_call.id = id;
          if (type) tool_call.type = type;
          if (fn) tool_call.function ??= { name: fn.name ?? '', arguments: '' };
          if (fn?.name) tool_call.function!.name = fn.name;
          if (fn?.arguments) {
            tool_call.function!.arguments += fn.arguments;

            if (shouldParseToolCall(this.#params, tool_call)) {
              tool_call.function!.parsed_arguments = partialParse(tool_call.function!.arguments);
            }
          }
        }
      }
    }
    return snapshot;
  }

  [Symbol.asyncIterator](this: ChatCompletionStream<ParsedT>): AsyncIterator<ChatCompletionChunk> {
    const pushQueue: ChatCompletionChunk[] = [];
    const readQueue: {
      resolve: (chunk: ChatCompletionChunk | undefined) => void;
      reject: (err: unknown) => void;
    }[] = [];
    let done = false;

    this.on('chunk', (chunk) => {
      const reader = readQueue.shift();
      if (reader) {
        reader.resolve(chunk);
      } else {
        pushQueue.push(chunk);
      }
    });

    this.on('end', () => {
      done = true;
      for (const reader of readQueue) {
        reader.resolve(undefined);
      }
      readQueue.length = 0;
    });

    this.on('abort', (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });

    this.on('error', (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });

    return {
      next: async (): Promise<IteratorResult<ChatCompletionChunk>> => {
        if (!pushQueue.length) {
          if (done) {
            return { value: undefined, done: true };
          }
          return new Promise<ChatCompletionChunk | undefined>((resolve, reject) =>
            readQueue.push({ resolve, reject }),
          ).then((chunk) => (chunk ? { value: chunk, done: false } : { value: undefined, done: true }));
        }
        const chunk = pushQueue.shift()!;
        return { value: chunk, done: false };
      },
      return: async () => {
        this.abort();
        return { value: undefined, done: true };
      },
    };
  }

  toReadableStream(): ReadableStream {
    const stream = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
    return stream.toReadableStream();
  }
}

function finalizeChatCompletion<ParsedT>(
  snapshot: ChatCompletionSnapshot,
  params: ChatCompletionCreateParams | null,
): ParsedChatCompletion<ParsedT> {
  const { id, choices, created, model, system_fingerprint, ...rest } = snapshot;
  const completion: ChatCompletion = {
    ...rest,
    id,
    choices: choices.map(
      ({ message, finish_reason, index, logprobs, ...choiceRest }): ChatCompletion.Choice => {
        if (!finish_reason) {
          throw new OpenAIError(`missing finish_reason for choice ${index}`);
        }

        const { content = null, function_call, tool_calls, ...messageRest } = message;
        const role = message.role as 'assistant'; // this is what we expect; in theory it could be different which would make our types a slight lie but would be fine.
        if (!role) {
          throw new OpenAIError(`missing role for choice ${index}`);
        }

        if (function_call) {
          const { arguments: args, name } = function_call;
          if (args == null) {
            throw new OpenAIError(`missing function_call.arguments for choice ${index}`);
          }

          if (!name) {
            throw new OpenAIError(`missing function_call.name for choice ${index}`);
          }

          return {
            ...choiceRest,
            message: {
              content,
              function_call: { arguments: args, name },
              role,
              refusal: message.refusal ?? null,
            },
            finish_reason,
            index,
            logprobs,
          };
        }

        if (tool_calls) {
          return {
            ...choiceRest,
            index,
            finish_reason,
            logprobs,
            message: {
              ...messageRest,
              role,
              content,
              refusal: message.refusal ?? null,
              tool_calls: tool_calls.map((tool_call, i) => {
                const { function: fn, type, id, ...toolRest } = tool_call;
                const { arguments: args, name, ...fnRest } = fn || {};
                if (id == null) {
                  throw new OpenAIError(`missing choices[${index}].tool_calls[${i}].id\n${str(snapshot)}`);
                }
                if (type == null) {
                  throw new OpenAIError(`missing choices[${index}].tool_calls[${i}].type\n${str(snapshot)}`);
                }
                if (name == null) {
                  throw new OpenAIError(
                    `missing choices[${index}].tool_calls[${i}].function.name\n${str(snapshot)}`,
                  );
                }
                if (args == null) {
                  throw new OpenAIError(
                    `missing choices[${index}].tool_calls[${i}].function.arguments\n${str(snapshot)}`,
                  );
                }

                return { ...toolRest, id, type, function: { ...fnRest, name, arguments: args } };
              }),
            },
          };
        }
        return {
          ...choiceRest,
          message: { ...messageRest, content, role, refusal: message.refusal ?? null },
          finish_reason,
          index,
          logprobs,
        };
      },
    ),
    created,
    model,
    object: 'chat.completion',
    ...(system_fingerprint ? { system_fingerprint } : {}),
  };

  return maybeParseChatCompletion(completion, params);
}

function str(x: unknown) {
  return JSON.stringify(x);
}

/**
 * Represents a streamed chunk of a chat completion response returned by model,
 * based on the provided input.
 */
export interface ChatCompletionSnapshot {
  /**
   * A unique identifier for the chat completion.
   */
  id: string;

  /**
   * A list of chat completion choices. Can be more than one if `n` is greater
   * than 1.
   */
  choices: Array<ChatCompletionSnapshot.Choice>;

  /**
   * The Unix timestamp (in seconds) of when the chat completion was created.
   */
  created: number;

  /**
   * The model to generate the completion.
   */
  model: string;

  // Note we do not include an "object" type on the snapshot,
  // because the object is not a valid "chat.completion" until finalized.
  // object: 'chat.completion';

  /**
   * This fingerprint represents the backend configuration that the model runs with.
   *
   * Can be used in conjunction with the `seed` request parameter to understand when
   * backend changes have been made that might impact determinism.
   */
  system_fingerprint?: string;
}

export namespace ChatCompletionSnapshot {
  export interface Choice {
    /**
     * A chat completion delta generated by streamed model responses.
     */
    message: Choice.Message;

    /**
     * The reason the model stopped generating tokens. This will be `stop` if the model
     * hit a natural stop point or a provided stop sequence, `length` if the maximum
     * number of tokens specified in the request was reached, `content_filter` if
     * content was omitted due to a flag from our content filters, or `function_call`
     * if the model called a function.
     */
    finish_reason: ChatCompletion.Choice['finish_reason'] | null;

    /**
     * Log probability information for the choice.
     */
    logprobs: ChatCompletion.Choice.Logprobs | null;

    /**
     * The index of the choice in the list of choices.
     */
    index: number;
  }

  export namespace Choice {
    /**
     * A chat completion delta generated by streamed model responses.
     */
    export interface Message {
      /**
       * The contents of the chunk message.
       */
      content?: string | null;

      refusal?: string | null;

      parsed?: unknown | null;

      /**
       * The name and arguments of a function that should be called, as generated by the
       * model.
       */
      function_call?: Message.FunctionCall;

      tool_calls?: Array<Message.ToolCall>;

      /**
       * The role of the author of this message.
       */
      role?: ChatCompletionRole;
    }

    export namespace Message {
      export interface ToolCall {
        /**
         * The ID of the tool call.
         */
        id: string;

        function: ToolCall.Function;

        /**
         * The type of the tool.
         */
        type: 'function';
      }

      export namespace ToolCall {
        export interface Function {
          /**
           * The arguments to call the function with, as generated by the model in JSON
           * format. Note that the model does not always generate valid JSON, and may
           * hallucinate parameters not defined by your function schema. Validate the
           * arguments in your code before calling your function.
           */
          arguments: string;

          parsed_arguments?: unknown;

          /**
           * The name of the function to call.
           */
          name: string;
        }
      }

      /**
       * The name and arguments of a function that should be called, as generated by the
       * model.
       */
      export interface FunctionCall {
        /**
         * The arguments to call the function with, as generated by the model in JSON
         * format. Note that the model does not always generate valid JSON, and may
         * hallucinate parameters not defined by your function schema. Validate the
         * arguments in your code before calling your function.
         */
        arguments?: string;

        /**
         * The name of the function to call.
         */
        name?: string;
      }
    }
  }
}

type AssertIsEmpty<T extends {}> = keyof T extends never ? T : never;

/**
 * Ensures the given argument is an empty object, useful for
 * asserting that all known properties on an object have been
 * destructured.
 */
function assertIsEmpty<T extends {}>(obj: AssertIsEmpty<T>): asserts obj is AssertIsEmpty<T> {
  return;
}

function assertNever(_x: never) {}
