import { createStreamIteratorWrapper } from "./stream-iterator-wrapper.js";
export function mergePluginTextTransforms(...transforms) {
    const input = transforms.flatMap((entry) => entry?.input ?? []);
    const output = transforms.flatMap((entry) => entry?.output ?? []);
    if (input.length === 0 && output.length === 0) {
        return undefined;
    }
    return {
        ...(input.length > 0 ? { input } : {}),
        ...(output.length > 0 ? { output } : {}),
    };
}
export function applyPluginTextReplacements(text, replacements) {
    if (!replacements || replacements.length === 0 || !text) {
        return text;
    }
    let next = text;
    for (const replacement of replacements) {
        next = next.replace(replacement.from, replacement.to);
    }
    return next;
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function transformContentText(content, replacements) {
    if (typeof content === "string") {
        return applyPluginTextReplacements(content, replacements);
    }
    if (Array.isArray(content)) {
        return content.map((entry) => transformContentText(entry, replacements));
    }
    if (!isRecord(content)) {
        return content;
    }
    const next = { ...content };
    if (typeof next.text === "string") {
        next.text = applyPluginTextReplacements(next.text, replacements);
    }
    if (Object.hasOwn(next, "content")) {
        next.content = transformContentText(next.content, replacements);
    }
    return next;
}
function transformMessageText(message, replacements) {
    if (!isRecord(message)) {
        return message;
    }
    const next = { ...message };
    if (Object.hasOwn(next, "content")) {
        next.content = transformContentText(next.content, replacements);
    }
    if (typeof next.errorMessage === "string") {
        next.errorMessage = applyPluginTextReplacements(next.errorMessage, replacements);
    }
    return next;
}
export function transformStreamContextText(context, replacements, options) {
    if (!replacements || replacements.length === 0) {
        return context;
    }
    return {
        ...context,
        systemPrompt: options?.systemPrompt !== false && typeof context.systemPrompt === "string"
            ? applyPluginTextReplacements(context.systemPrompt, replacements)
            : context.systemPrompt,
        messages: Array.isArray(context.messages)
            ? context.messages.map((message) => transformMessageText(message, replacements))
            : context.messages,
    };
}
function transformAssistantEventText(event, replacements) {
    if (!isRecord(event) || !replacements || replacements.length === 0) {
        return event;
    }
    const next = { ...event };
    if (next.type === "text_delta" && typeof next.delta === "string") {
        next.delta = applyPluginTextReplacements(next.delta, replacements);
    }
    if (next.type === "text_end" && typeof next.content === "string") {
        next.content = applyPluginTextReplacements(next.content, replacements);
    }
    if (Object.hasOwn(next, "partial")) {
        next.partial = transformMessageText(next.partial, replacements);
    }
    if (Object.hasOwn(next, "message")) {
        next.message = transformMessageText(next.message, replacements);
    }
    if (Object.hasOwn(next, "error")) {
        next.error = transformMessageText(next.error, replacements);
    }
    return next;
}
function wrapStreamTextTransforms(stream, replacements) {
    if (!replacements || replacements.length === 0) {
        return stream;
    }
    const originalResult = stream.result.bind(stream);
    stream.result = async () => transformMessageText(await originalResult(), replacements);
    const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] =
        function () {
            const iterator = originalAsyncIterator();
            return createStreamIteratorWrapper({
                iterator,
                next: async (streamIterator) => {
                    const result = await streamIterator.next();
                    return result.done
                        ? result
                        : {
                            done: false,
                            value: transformAssistantEventText(result.value, replacements),
                        };
                },
            });
        };
    return stream;
}
export function wrapStreamFnTextTransforms(params) {
    return (model, context, options) => {
        const nextContext = transformStreamContextText(context, params.input, {
            systemPrompt: params.transformSystemPrompt,
        });
        const maybeStream = params.streamFn(model, nextContext, options);
        if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
            return Promise.resolve(maybeStream).then((stream) => wrapStreamTextTransforms(stream, params.output));
        }
        return wrapStreamTextTransforms(maybeStream, params.output);
    };
}
