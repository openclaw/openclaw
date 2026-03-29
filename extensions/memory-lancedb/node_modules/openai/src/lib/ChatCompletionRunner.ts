import {
  type ChatCompletionMessageParam,
  type ChatCompletionCreateParamsNonStreaming,
} from '../resources/chat/completions';
import { type BaseFunctionsArgs, RunnableTools } from './RunnableFunction';
import {
  AbstractChatCompletionRunner,
  AbstractChatCompletionRunnerEvents,
  RunnerOptions,
} from './AbstractChatCompletionRunner';
import { isAssistantMessage } from './chatCompletionUtils';
import OpenAI from '../index';
import { AutoParseableTool } from '../lib/parser';

export interface ChatCompletionRunnerEvents extends AbstractChatCompletionRunnerEvents {
  content: (content: string) => void;
}

export type ChatCompletionToolRunnerParams<FunctionsArgs extends BaseFunctionsArgs> = Omit<
  ChatCompletionCreateParamsNonStreaming,
  'tools'
> & {
  tools: RunnableTools<FunctionsArgs> | AutoParseableTool<any, true>[];
};

export class ChatCompletionRunner<ParsedT = null> extends AbstractChatCompletionRunner<
  ChatCompletionRunnerEvents,
  ParsedT
> {
  static runTools<ParsedT>(
    client: OpenAI,
    params: ChatCompletionToolRunnerParams<any[]>,
    options?: RunnerOptions,
  ): ChatCompletionRunner<ParsedT> {
    const runner = new ChatCompletionRunner<ParsedT>();
    const opts = {
      ...options,
      headers: { ...options?.headers, 'X-Stainless-Helper-Method': 'runTools' },
    };
    runner._run(() => runner._runTools(client, params, opts));
    return runner;
  }

  override _addMessage(
    this: ChatCompletionRunner<ParsedT>,
    message: ChatCompletionMessageParam,
    emit: boolean = true,
  ) {
    super._addMessage(message, emit);
    if (isAssistantMessage(message) && message.content) {
      this._emit('content', message.content as string);
    }
  }
}
