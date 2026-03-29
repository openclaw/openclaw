import { type ChatCompletionRunner } from './ChatCompletionRunner';
import { type ChatCompletionStreamingRunner } from './ChatCompletionStreamingRunner';
import { JSONSchema } from './jsonschema';

type PromiseOrValue<T> = T | Promise<T>;

export type RunnableFunctionWithParse<Args extends object> = {
  /**
   * @param args the return value from `parse`.
   * @param runner the runner evaluating this callback.
   * @returns a string to send back to OpenAI.
   */
  function: (
    args: Args,
    runner: ChatCompletionRunner<unknown> | ChatCompletionStreamingRunner<unknown>,
  ) => PromiseOrValue<unknown>;
  /**
   * @param input the raw args from the OpenAI function call.
   * @returns the parsed arguments to pass to `function`
   */
  parse: (input: string) => PromiseOrValue<Args>;
  /**
   * The parameters the function accepts, describes as a JSON Schema object.
   */
  parameters: JSONSchema;
  /**
   * A description of what the function does, used by the model to choose when and how to call the function.
   */
  description: string;
  /**
   * The name of the function to be called. Will default to function.name if omitted.
   */
  name?: string | undefined;
  strict?: boolean | undefined;
};

export type RunnableFunctionWithoutParse = {
  /**
   * @param args the raw args from the OpenAI function call.
   * @returns a string to send back to OpenAI
   */
  function: (
    args: string,
    runner: ChatCompletionRunner<unknown> | ChatCompletionStreamingRunner<unknown>,
  ) => PromiseOrValue<unknown>;
  /**
   * The parameters the function accepts, describes as a JSON Schema object.
   */
  parameters: JSONSchema;
  /**
   * A description of what the function does, used by the model to choose when and how to call the function.
   */
  description: string;
  /**
   * The name of the function to be called. Will default to function.name if omitted.
   */
  name?: string | undefined;
  strict?: boolean | undefined;
};

export type RunnableFunction<Args extends object | string> =
  Args extends string ? RunnableFunctionWithoutParse
  : Args extends object ? RunnableFunctionWithParse<Args>
  : never;

export type RunnableToolFunction<Args extends object | string> =
  Args extends string ? RunnableToolFunctionWithoutParse
  : Args extends object ? RunnableToolFunctionWithParse<Args>
  : never;

export type RunnableToolFunctionWithoutParse = {
  type: 'function';
  function: RunnableFunctionWithoutParse;
};
export type RunnableToolFunctionWithParse<Args extends object> = {
  type: 'function';
  function: RunnableFunctionWithParse<Args>;
};

export function isRunnableFunctionWithParse<Args extends object>(
  fn: any,
): fn is RunnableFunctionWithParse<Args> {
  return typeof (fn as any).parse === 'function';
}

export type BaseFunctionsArgs = readonly (object | string)[];

export type RunnableFunctions<FunctionsArgs extends BaseFunctionsArgs> =
  [any[]] extends [FunctionsArgs] ? readonly RunnableFunction<any>[]
  : {
      [Index in keyof FunctionsArgs]: Index extends number ? RunnableFunction<FunctionsArgs[Index]>
      : FunctionsArgs[Index];
    };

export type RunnableTools<FunctionsArgs extends BaseFunctionsArgs> =
  [any[]] extends [FunctionsArgs] ? readonly RunnableToolFunction<any>[]
  : {
      [Index in keyof FunctionsArgs]: Index extends number ? RunnableToolFunction<FunctionsArgs[Index]>
      : FunctionsArgs[Index];
    };

/**
 * This is helper class for passing a `function` and `parse` where the `function`
 * argument type matches the `parse` return type.
 */
export class ParsingToolFunction<Args extends object> {
  type: 'function';
  function: RunnableFunctionWithParse<Args>;

  constructor(input: RunnableFunctionWithParse<Args>) {
    this.type = 'function';
    this.function = input;
  }
}
