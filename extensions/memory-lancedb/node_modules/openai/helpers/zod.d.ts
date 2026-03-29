import { ResponseFormatJSONSchema } from "../resources/index.js";
import * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';
import { AutoParseableResponseFormat, AutoParseableTextFormat, AutoParseableTool } from "../lib/parser.js";
import { AutoParseableResponseTool } from "../lib/ResponsesParser.js";
import { type ResponseFormatTextJSONSchemaConfig } from "../resources/responses/responses.js";
type InferZodType<T> = T extends z4.ZodType ? z4.infer<T> : T extends z3.ZodType ? z3.infer<T> : never;
/**
 * Creates a chat completion `JSONSchema` response format object from
 * the given Zod schema.
 *
 * If this is passed to the `.parse()`, `.stream()` or `.runTools()`
 * chat completion methods then the response message will contain a
 * `.parsed` property that is the result of parsing the content with
 * the given Zod object.
 *
 * ```ts
 * const completion = await client.chat.completions.parse({
 *    model: 'gpt-4o-2024-08-06',
 *    messages: [
 *      { role: 'system', content: 'You are a helpful math tutor.' },
 *      { role: 'user', content: 'solve 8x + 31 = 2' },
 *    ],
 *    response_format: zodResponseFormat(
 *      z.object({
 *        steps: z.array(z.object({
 *          explanation: z.string(),
 *          answer: z.string(),
 *        })),
 *        final_answer: z.string(),
 *      }),
 *      'math_answer',
 *    ),
 *  });
 *  const message = completion.choices[0]?.message;
 *  if (message?.parsed) {
 *    console.log(message.parsed);
 *    console.log(message.parsed.final_answer);
 * }
 * ```
 *
 * This can be passed directly to the `.create()` method but will not
 * result in any automatic parsing, you'll have to parse the response yourself.
 */
export declare function zodResponseFormat<ZodInput extends z3.ZodType | z4.ZodType>(zodObject: ZodInput, name: string, props?: Omit<ResponseFormatJSONSchema.JSONSchema, 'schema' | 'strict' | 'name'>): AutoParseableResponseFormat<InferZodType<ZodInput>>;
export declare function zodTextFormat<ZodInput extends z3.ZodType | z4.ZodType>(zodObject: ZodInput, name: string, props?: Omit<ResponseFormatTextJSONSchemaConfig, 'schema' | 'type' | 'strict' | 'name'>): AutoParseableTextFormat<InferZodType<ZodInput>>;
/**
 * Creates a chat completion `function` tool that can be invoked
 * automatically by the chat completion `.runTools()` method or automatically
 * parsed by `.parse()` / `.stream()`.
 */
export declare function zodFunction<Parameters extends z3.ZodType | z4.ZodType>(options: {
    name: string;
    parameters: Parameters;
    function?: ((args: InferZodType<Parameters>) => unknown | Promise<unknown>) | undefined;
    description?: string | undefined;
}): AutoParseableTool<{
    arguments: Parameters;
    name: string;
    function: (args: InferZodType<Parameters>) => unknown;
}>;
export declare function zodResponsesFunction<Parameters extends z3.ZodType | z4.ZodType>(options: {
    name: string;
    parameters: Parameters;
    function?: ((args: InferZodType<Parameters>) => unknown | Promise<unknown>) | undefined;
    description?: string | undefined;
}): AutoParseableResponseTool<{
    arguments: Parameters;
    name: string;
    function: (args: InferZodType<Parameters>) => unknown;
}>;
export {};
//# sourceMappingURL=zod.d.ts.map