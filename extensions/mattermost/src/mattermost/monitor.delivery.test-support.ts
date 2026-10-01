export type ObservedTestDelivery<TPayload, TInfo, TResult> = {
  deliver: (payload: TPayload, info: TInfo) => Promise<TResult>;
  onDelivered?: (payload: TPayload, info: TInfo, result: TResult) => Promise<void> | void;
  onError?: unknown;
};

export function bindTestDeliveryObserver<TPayload, TInfo, TResult>(
  delivery: ObservedTestDelivery<TPayload, TInfo, TResult>,
) {
  return async (payload: TPayload, info: TInfo) => {
    const result = await delivery.deliver(payload, info);
    await delivery.onDelivered?.(payload, info, result);
    return result;
  };
}
