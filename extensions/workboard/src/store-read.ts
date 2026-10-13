import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { WorkboardCardReadScope, WorkboardCardStore } from "./persistence-types.js";
import { compareCards } from "./store-card-helpers.js";

export function freezeCardList(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeCardList(child);
    }
    Object.freeze(value);
  }
}

export async function readCards(
  store: WorkboardCardStore,
  scope?: WorkboardCardReadScope,
): Promise<WorkboardCard[]> {
  const entries = await store.entries(scope);
  return entries
    .flatMap(({ value }) => (value?.version === 1 && value.card?.id ? [value.card] : []))
    .toSorted(compareCards);
}
