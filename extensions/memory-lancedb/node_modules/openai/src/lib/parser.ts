import { ContentFilterFinishReasonError, LengthFinishReasonError, OpenAIError } from '../error';
import {
  ChatCompletion,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsBase,
  ChatCompletionFunctionTool,
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionStreamingToolRunnerParams,
  ChatCompletionStreamParams,
  ChatCompletionToolRunnerParams,
  ParsedChatCompletion,
  ParsedChoice,
  ParsedFunctionToolCall,
} from '../resources/chat/completions';
import { type ResponseFormatTextJSONSchemaConfig } from '../resources/responses/responses';
import { ResponseFormatJSONSchema } from '../resources/shared';

type AnyChatCompletionCreateParams =
  | ChatCompletionCreateParams
  | ChatCompletionToolRunnerParams<any>
  | ChatCompletionStreamingToolRunnerParams<any>
  | ChatCompletionStreamParams;

type Unpacked<T> = T extends (infer U)[] ? U : T;

type ToolCall = Unpacked<ChatCompletionCreateParamsBase['tools']>;

export function isChatCompletionFunctionTool(tool: ToolCall): tool is ChatCompletionFunctionTool {
  return tool !== undefined && 'function' in tool && tool.function !== undefined;
}

export type ExtractParsedContentFromParams<Params extends AnyChatCompletionCreateParams> =
  Params['response_format'] extends AutoParseableResponseFormat<infer P> ? P : null;

export type AutoParseableResponseFormat<ParsedT> = ResponseFormatJSONSchema & {
  __output: ParsedT; // type-level only

  $brand: 'auto-parseable-response-format';
  $parseRaw(content: string): ParsedT;
};

export function makeParseableResponseFormat<ParsedT>(
  response_format: ResponseFormatJSONSchema,
  parser: (content: string) => ParsedT,
): AutoParseableResponseFormat<ParsedT> {
  const obj = { ...response_format };

  Object.defineProperties(obj, {
    $brand: {
      value: 'auto-parseable-response-format',
      enumerable: false,
    },
    $parseRaw: {
      value: parser,
      enumerable: false,
    },
  });

  return obj as AutoParseableResponseFormat<ParsedT>;
}

export type AutoParseableTextFormat<ParsedT> = ResponseFormatTextJSONSchemaConfig & {
  __output: ParsedT; // type-level only

  $brand: 'auto-parseable-response-format';
  $parseRaw(content: string): ParsedT;
};

export function makeParseableTextFormat<ParsedT>(
  response_format: ResponseFormatTextJSONSchemaConfig,
  parser: (content: string) => ParsedT,
): AutoParseableTextFormat<ParsedT> {
  const obj = { ...response_format };

  Object.defineProperties(obj, {
    $brand: {
      value: 'auto-parseable-response-format',
      enumerable: false,
    },
    $parseRaw: {
      value: parser,
      enumerable: false,
    },
  });

  return obj as AutoParseableTextFormat<ParsedT>;
}

export function isAutoParsableResponseFormat<ParsedT>(
  response_format: any,
): response_format is AutoParseableResponseFormat<ParsedT> {
  return response_format?.['$brand'] === 'auto-parseable-response-format';
}

type ToolOptions = {
  name: string;
  arguments: any;
  function?: ((args: any) => any) | undefined;
};

export type AutoParseableTool<
  OptionsT extends ToolOptions,
  HasFunction = OptionsT['function'] extends Function ? true : false,
> = ChatCompletionFunctionTool & {
  __arguments: OptionsT['arguments']; // type-level only
  __name: OptionsT['name']; // type-level only
  __hasFunction: HasFunction; // type-level only

  $brand: 'auto-parseable-tool';
  $callback: ((args: OptionsT['arguments']) => any) | undefined;
  $parseRaw(args: string): OptionsT['arguments'];
};

export function makeParseableTool<OptionsT extends ToolOptions>(
  tool: ChatCompletionFunctionTool,
  {
    parser,
    callback,
  }: {
    parser: (content: string) => OptionsT['arguments'];
    callback: ((args: any) => any) | undefined;
  },
): AutoParseableTool<OptionsT['arguments']> {
  const obj = { ...tool };

  Object.defineProperties(obj, {
    $brand: {
      value: 'auto-parseable-tool',
      enumerable: false,
    },
    $parseRaw: {
      value: parser,
      enumerable: false,
    },
    $callback: {
      value: callback,
      enumerable: false,
    },
  });

  return obj as AutoParseableTool<OptionsT['arguments']>;
}

export function isAutoParsableTool(tool: any): tool is AutoParseableTool<any> {
  return tool?.['$brand'] === 'auto-parseable-tool';
}

export function maybeParseChatCompletion<
  Params extends ChatCompletionCreateParams | null,
  ParsedT = Params extends null ? null : ExtractParsedContentFromParams<NonNullable<Params>>,
>(completion: ChatCompletion, params: Params): ParsedChatCompletion<ParsedT> {
  if (!params || !hasAutoParseableInput(params)) {
    return {
      ...completion,
      choices: completion.choices.map((choice) => {
        assertToolCallsAreChatCompletionFunctionToolCalls(choice.message.tool_calls);

        return {
          ...choice,
          message: {
            ...choice.message,
            parsed: null,
            ...(choice.message.tool_calls ?
              {
                tool_calls: choice.message.tool_calls,
              }
            : undefined),
          },
        };
      }),
    } as ParsedChatCompletion<ParsedT>;
  }

  return parseChatCompletion(completion, params);
}

export function parseChatCompletion<
  Params extends ChatCompletionCreateParams,
  ParsedT = ExtractParsedContentFromParams<Params>,
>(completion: ChatCompletion, params: Params): ParsedChatCompletion<ParsedT> {
  const choices: Array<ParsedChoice<ParsedT>> = completion.choices.map((choice): ParsedChoice<ParsedT> => {
    if (choice.finish_reason === 'length') {
      throw new LengthFinishReasonError();
    }

    if (choice.finish_reason === 'content_filter') {
      throw new ContentFilterFinishReasonError();
    }

    assertToolCallsAreChatCompletionFunctionToolCalls(choice.message.tool_calls);

    return {
      ...choice,
      message: {
        ...choice.message,
        ...(choice.message.tool_calls ?
          {
            tool_calls:
              choice.message.tool_calls?.map((toolCall) => parseToolCall(params, toolCall)) ?? undefined,
          }
        : undefined),
        parsed:
          choice.message.content && !choice.message.refusal ?
            parseResponseFormat(params, choice.message.content)
          : null,
      },
    } as ParsedChoice<ParsedT>;
  });

  return { ...completion, choices };
}

function parseResponseFormat<
  Params extends ChatCompletionCreateParams,
  ParsedT = ExtractParsedContentFromParams<Params>,
>(params: Params, content: string): ParsedT | null {
  if (params.response_format?.type !== 'json_schema') {
    return null;
  }

  if (params.response_format?.type === 'json_schema') {
    if ('$parseRaw' in params.response_format) {
      const response_format = params.response_format as AutoParseableResponseFormat<ParsedT>;

      return response_format.$parseRaw(content);
    }

    return JSON.parse(content);
  }

  return null;
}

function parseToolCall<Params extends ChatCompletionCreateParams>(
  params: Params,
  toolCall: ChatCompletionMessageFunctionToolCall,
): ParsedFunctionToolCall {
  const inputTool = params.tools?.find(
    (inputTool) =>
      isChatCompletionFunctionTool(inputTool) && inputTool.function?.name === toolCall.function.name,
  ) as ChatCompletionFunctionTool | undefined; // TS doesn't narrow based on isChatCompletionTool
  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      parsed_arguments:
        isAutoParsableTool(inputTool) ? inputTool.$parseRaw(toolCall.function.arguments)
        : inputTool?.function.strict ? JSON.parse(toolCall.function.arguments)
        : null,
    },
  };
}

export function shouldParseToolCall(
  params: ChatCompletionCreateParams | null | undefined,
  toolCall: ChatCompletionMessageFunctionToolCall,
): boolean {
  if (!params || !('tools' in params) || !params.tools) {
    return false;
  }

  const inputTool = params.tools?.find(
    (inputTool) =>
      isChatCompletionFunctionTool(inputTool) && inputTool.function?.name === toolCall.function.name,
  );
  return (
    isChatCompletionFunctionTool(inputTool) &&
    (isAutoParsableTool(inputTool) || inputTool?.function.strict || false)
  );
}

export function hasAutoParseableInput(params: AnyChatCompletionCreateParams): boolean {
  if (isAutoParsableResponseFormat(params.response_format)) {
    return true;
  }

  return (
    params.tools?.some(
      (t) => isAutoParsableTool(t) || (t.type === 'function' && t.function.strict === true),
    ) ?? false
  );
}

export function assertToolCallsAreChatCompletionFunctionToolCalls(
  toolCalls: ChatCompletionMessage['tool_calls'],
): asserts toolCalls is ChatCompletionMessageFunctionToolCall[] {
  for (const toolCall of toolCalls || []) {
    if (toolCall.type !== 'function') {
      throw new OpenAIError(
        `Currently only \`function\` tool calls are supported; Received \`${toolCall.type}\``,
      );
    }
  }
}

export function validateInputTools(tools: ChatCompletionCreateParamsBase['tools']) {
  for (const tool of tools ?? []) {
    if (tool.type !== 'function') {
      throw new OpenAIError(
        `Currently only \`function\` tool types support auto-parsing; Received \`${tool.type}\``,
      );
    }

    if (tool.function.strict !== true) {
      throw new OpenAIError(
        `The \`${tool.function.name}\` tool is not marked with \`strict: true\`. Only strict function tools can be auto-parsed`,
      );
    }
  }
}
