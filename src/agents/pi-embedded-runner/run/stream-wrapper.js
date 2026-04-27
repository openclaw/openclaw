import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";
export function wrapStreamObjectEvents(stream, onEvent) {
    const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] =
        function () {
            const iterator = originalAsyncIterator();
            return createStreamIteratorWrapper({
                iterator,
                next: async (streamIterator) => {
                    const result = await streamIterator.next();
                    if (!result.done && result.value && typeof result.value === "object") {
                        await onEvent(result.value);
                    }
                    return result;
                },
            });
        };
    return stream;
}
