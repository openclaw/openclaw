export function createStreamIteratorWrapper(params) {
    const wrapper = {
        async next() {
            return params.next(params.iterator);
        },
        async return(value) {
            return ((await params.onReturn?.(params.iterator, value)) ??
                (await params.iterator.return?.(value)) ?? { done: true, value: undefined });
        },
        async throw(error) {
            return ((await params.onThrow?.(params.iterator, error)) ??
                (await params.iterator.throw?.(error)) ?? { done: true, value: undefined });
        },
        [Symbol.asyncIterator]() {
            return this;
        },
    };
    return wrapper;
}
