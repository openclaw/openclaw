/** Serialize snapshots so an older delivery cannot overtake its replacement. */
export function enqueuePrDelivery(
  owner: { delivery?: Promise<void> },
  deliver: () => Promise<void>,
): Promise<void> {
  const delivery = (owner.delivery ?? Promise.resolve()).then(deliver).finally(() => {
    if (owner.delivery === delivery) {
      delete owner.delivery;
    }
  });
  owner.delivery = delivery;
  return delivery;
}
