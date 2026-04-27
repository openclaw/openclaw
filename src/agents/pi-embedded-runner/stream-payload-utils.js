export function streamWithPayloadPatch(underlying, model, context, options, patchPayload) {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
        ...options,
        onPayload: (payload) => {
            if (payload && typeof payload === "object") {
                patchPayload(payload);
            }
            return originalOnPayload?.(payload, model);
        },
    });
}
