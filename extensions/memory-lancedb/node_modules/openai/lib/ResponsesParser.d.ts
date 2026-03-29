import type { ChatCompletionTool } from "../resources/chat/completions.js";
import { ResponseTextConfig, type FunctionTool, type ParsedResponse, type Response, type ResponseCreateParamsBase, type ResponseCreateParamsNonStreaming, type ResponseFunctionToolCall, type Tool } from "../resources/responses/responses.js";
import { type AutoParseableTextFormat } from "../lib/parser.js";
export type ParseableToolsParams = Array<Tool> | ChatCompletionTool | null;
export type ResponseCreateParamsWithTools = ResponseCreateParamsBase & {
    tools?: ParseableToolsParams;
};
type TextConfigParams = {
    text?: ResponseTextConfig;
};
export type ExtractParsedContentFromParams<Params extends TextConfigParams> = NonNullable<Params['text']>['format'] extends AutoParseableTextFormat<infer P> ? P : null;
export declare function maybeParseResponse<Params extends ResponseCreateParamsBase | null, ParsedT = Params extends null ? null : ExtractParsedContentFromParams<NonNullable<Params>>>(response: Response, params: Params): ParsedResponse<ParsedT>;
export declare function parseResponse<Params extends ResponseCreateParamsBase, ParsedT = ExtractParsedContentFromParams<Params>>(response: Response, params: Params): ParsedResponse<ParsedT>;
export declare function hasAutoParseableInput(params: ResponseCreateParamsWithTools): boolean;
type ToolOptions = {
    name: string;
    arguments: any;
    function?: ((args: any) => any) | undefined;
};
export type AutoParseableResponseTool<OptionsT extends ToolOptions, HasFunction = OptionsT['function'] extends Function ? true : false> = FunctionTool & {
    __arguments: OptionsT['arguments'];
    __name: OptionsT['name'];
    $brand: 'auto-parseable-tool';
    $callback: ((args: OptionsT['arguments']) => any) | undefined;
    $parseRaw(args: string): OptionsT['arguments'];
};
export declare function makeParseableResponseTool<OptionsT extends ToolOptions>(tool: FunctionTool, { parser, callback, }: {
    parser: (content: string) => OptionsT['arguments'];
    callback: ((args: any) => any) | undefined;
}): AutoParseableResponseTool<OptionsT['arguments']>;
export declare function isAutoParsableTool(tool: any): tool is AutoParseableResponseTool<any>;
export declare function shouldParseToolCall(params: ResponseCreateParamsNonStreaming | null | undefined, toolCall: ResponseFunctionToolCall): boolean;
export declare function validateInputTools(tools: ChatCompletionTool[] | undefined): void;
export declare function addOutputText(rsp: Response): void;
export {};
//# sourceMappingURL=ResponsesParser.d.ts.map