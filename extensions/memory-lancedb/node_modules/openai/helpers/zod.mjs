import * as z4 from 'zod/v4';
import { makeParseableResponseFormat, makeParseableTextFormat, makeParseableTool, } from "../lib/parser.mjs";
import { zodToJsonSchema as _zodToJsonSchema } from "../_vendor/zod-to-json-schema/index.mjs";
import { makeParseableResponseTool } from "../lib/ResponsesParser.mjs";
import { toStrictJsonSchema } from "../lib/transform.mjs";
function zodV3ToJsonSchema(schema, options) {
    return _zodToJsonSchema(schema, {
        openaiStrictMode: true,
        name: options.name,
        nameStrategy: 'duplicate-ref',
        $refStrategy: 'extract-to-root',
        nullableStrategy: 'property',
    });
}
function zodV4ToJsonSchema(schema) {
    return toStrictJsonSchema(z4.toJSONSchema(schema, {
        target: 'draft-7',
    }));
}
function isZodV4(zodObject) {
    return '_zod' in zodObject;
}
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
export function zodResponseFormat(zodObject, name, props) {
    return makeParseableResponseFormat({
        type: 'json_schema',
        json_schema: {
            ...props,
            name,
            strict: true,
            schema: isZodV4(zodObject) ? zodV4ToJsonSchema(zodObject) : zodV3ToJsonSchema(zodObject, { name }),
        },
    }, (content) => zodObject.parse(JSON.parse(content)));
}
export function zodTextFormat(zodObject, name, props) {
    return makeParseableTextFormat({
        type: 'json_schema',
        ...props,
        name,
        strict: true,
        schema: isZodV4(zodObject) ? zodV4ToJsonSchema(zodObject) : zodV3ToJsonSchema(zodObject, { name }),
    }, (content) => zodObject.parse(JSON.parse(content)));
}
/**
 * Creates a chat completion `function` tool that can be invoked
 * automatically by the chat completion `.runTools()` method or automatically
 * parsed by `.parse()` / `.stream()`.
 */
export function zodFunction(options) {
    // @ts-expect-error TODO
    return makeParseableTool({
        type: 'function',
        function: {
            name: options.name,
            parameters: isZodV4(options.parameters) ?
                zodV4ToJsonSchema(options.parameters)
                : zodV3ToJsonSchema(options.parameters, { name: options.name }),
            strict: true,
            ...(options.description ? { description: options.description } : undefined),
        },
    }, {
        callback: options.function,
        parser: (args) => options.parameters.parse(JSON.parse(args)),
    });
}
export function zodResponsesFunction(options) {
    return makeParseableResponseTool({
        type: 'function',
        name: options.name,
        parameters: isZodV4(options.parameters) ?
            zodV4ToJsonSchema(options.parameters)
            : zodV3ToJsonSchema(options.parameters, { name: options.name }),
        strict: true,
        ...(options.description ? { description: options.description } : undefined),
    }, {
        callback: options.function,
        parser: (args) => options.parameters.parse(JSON.parse(args)),
    });
}
//# sourceMappingURL=zod.mjs.map