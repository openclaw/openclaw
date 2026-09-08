import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

/** Emit each item only after the previous delivery attempt has settled. */
export function emitInSettlementOrder<T>(params: {
  items: readonly T[];
  emit: (item: T) => void;
  settle: () => void | Promise<void>;
}): void | Promise<void> {
  const emitAt = (start: number): void | Promise<void> => {
    let index = start;
    while (index < params.items.length) {
      params.emit(params.items[index]!);
      index += 1;
      const settlement = params.settle();
      if (isPromiseLike<void>(settlement)) {
        return Promise.resolve(settlement).then(() => emitAt(index));
      }
    }
  };
  return emitAt(0);
}
