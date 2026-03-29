import { OpenAIError } from '../error';
import type { ChatCompletionTool } from '../resources/chat/completions';
import {
  ResponseTextConfig,
  type FunctionTool,
  type ParsedContent,
  type ParsedResponse,
  type ParsedResponseFunctionToolCall,
  type ParsedResponseOutputItem,
  type Response,
  type ResponseCreateParamsBase,
  type ResponseCreateParamsNonStreaming,
  type ResponseFunctionToolCall,
  type Tool,
} from '../resources/responses/responses';
import { type AutoParseableTextFormat, isAutoParsableResponseFormat } from '../lib/parser';

export type ParseableToolsParams = Array<Tool> | ChatCompletionTool | null;

export type ResponseCreateParamsWithTools = ResponseCreateParamsBase & {
  tools?: ParseableToolsParams;
};

type TextConfigParams = { text?: ResponseTextConfig };

export type ExtractParsedContentFromParams<Params extends TextConfigParams> =
  NonNullable<Params['text']>['format'] extends AutoParseableTextFormat<infer P> ? P : null;

export function maybeParseResponse<
  Params extends ResponseCreateParamsBase | null,
  ParsedT = Params extends null ? null : ExtractParsedContentFromParams<NonNullable<Params>>,
>(response: Response, params: Params): ParsedResponse<ParsedT> {
  if (!params || !hasAutoParseableInput(params)) {
    return {
      ...response,
      output_parsed: null,
      output: response.output.map((item) => {
        if (item.type === 'function_call') {
          return {
            ...item,
            parsed_arguments: null,
          };
        }

        if (item.type === 'message') {
          return {
            ...item,
            content: item.content.map((content) => ({
              ...content,
              parsed: null,
            })),
          };
        } else {
          return item;
        }
      }),
    };
  }

  return parseResponse(response, params);
}

export function parseResponse<
  Params extends ResponseCreateParamsBase,
  ParsedT = ExtractParsedContentFromParams<Params>,
>(response: Response, params: Params): ParsedResponse<ParsedT> {
  const output: Array<ParsedResponseOutputItem<ParsedT>> = response.output.map(
    (item): ParsedResponseOutputItem<ParsedT> => {
      if (item.type === 'function_call') {
        return {
          ...item,
          parsed_arguments: parseToolCall(params, item),
        };
      }
      if (item.type === 'message') {
        const content: Array<ParsedContent<ParsedT>> = item.content.map((content) => {
          if (content.type === 'output_text') {
            return {
              ...content,
              parsed: parseTextFormat(params, content.text),
            };
          }

          return content;
        });

        return {
          ...item,
          content,
        };
      }

      return item;
    },
  );

  const parsed: Omit<ParsedResponse<ParsedT>, 'output_parsed'> = Object.assign({}, response, { output });
  if (!Object.getOwnPropertyDescriptor(response, 'output_text')) {
    addOutputText(parsed);
  }

  Object.defineProperty(parsed, 'output_parsed', {
    enumerable: true,
    get() {
      for (const output of parsed.output) {
        if (output.type !== 'message') {
          continue;
        }

        for (const content of output.content) {
          if (content.type === 'output_text' && content.parsed !== null) {
            return content.parsed;
          }
        }
      }

      return null;
    },
  });

  return parsed as ParsedResponse<ParsedT>;
}

function parseTextFormat<
  Params extends ResponseCreateParamsBase,
  ParsedT = ExtractParsedContentFromParams<Params>,
>(params: Params, content: string): ParsedT | null {
  if (params.text?.format?.type !== 'json_schema') {
    return null;
  }

  if ('$parseRaw' in params.text?.format) {
    const text_format = params.text?.format as unknown as AutoParseableTextFormat<ParsedT>;
    return text_format.$parseRaw(content);
  }

  return JSON.parse(content);
}

export function hasAutoParseableInput(params: ResponseCreateParamsWithTools): boolean {
  if (isAutoParsableResponseFormat(params.text?.format)) {
    return true;
  }

  return false;
}

type ToolOptions = {
  name: string;
  arguments: any;
  function?: ((args: any) => any) | undefined;
};

export type AutoParseableResponseTool<
  OptionsT extends ToolOptions,
  HasFunction = OptionsT['function'] extends Function ? true : false,
> = FunctionTool & {
  __arguments: OptionsT['arguments']; // type-level only
  __name: OptionsT['name']; // type-level only

  $brand: 'auto-parseable-tool';
  $callback: ((args: OptionsT['arguments']) => any) | undefined;
  $parseRaw(args: string): OptionsT['arguments'];
};

export function makeParseableResponseTool<OptionsT extends ToolOptions>(
  tool: FunctionTool,
  {
    parser,
    callback,
  }: {
    parser: (content: string) => OptionsT['arguments'];
    callback: ((args: any) => any) | undefined;
  },
): AutoParseableResponseTool<OptionsT['arguments']> {
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

  return obj as AutoParseableResponseTool<OptionsT['arguments']>;
}

export function isAutoParsableTool(tool: any): tool is AutoParseableResponseTool<any> {
  return tool?.['$brand'] === 'auto-parseable-tool';
}

function getInputToolByName(input_tools: Array<Tool>, name: string): FunctionTool | undefined {
  return input_tools.find((tool) => tool.type === 'function' && tool.name === name) as
    | FunctionTool
    | undefined;
}

function parseToolCall<Params extends ResponseCreateParamsBase>(
  params: Params,
  toolCall: ResponseFunctionToolCall,
): ParsedResponseFunctionToolCall {
  const inputTool = getInputToolByName(params.tools ?? [], toolCall.name);

  return {
    ...toolCall,
    ...toolCall,
    parsed_arguments:
      isAutoParsableTool(inputTool) ? inputTool.$parseRaw(toolCall.arguments)
      : inputTool?.strict ? JSON.parse(toolCall.arguments)
      : null,
  };
}

export function shouldParseToolCall(
  params: ResponseCreateParamsNonStreaming | null | undefined,
  toolCall: ResponseFunctionToolCall,
): boolean {
  if (!params) {
    return false;
  }

  const inputTool = getInputToolByName(params.tools ?? [], toolCall.name);
  return isAutoParsableTool(inputTool) || inputTool?.strict || false;
}

export function validateInputTools(tools: ChatCompletionTool[] | undefined) {
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

export function addOutputText(rsp: Response): void {
  const texts: string[] = [];
  for (const output of rsp.output) {
    if (output.type !== 'message') {
      continue;
    }

    for (const content of output.content) {
      if (content.type === 'output_text') {
        texts.push(content.text);
      }
    }
  }

  rsp.output_text = texts.join('');
}
