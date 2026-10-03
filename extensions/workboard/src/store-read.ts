import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { WorkboardCardReadScope, WorkboardCardStore } from "./persistence-types.js";
import { compareCards } from "./store-card-helpers.js";

export async function readCards(
  store: WorkboardCardStore,
  scope?: WorkboardCardReadScope,
): Promise<WorkboardCard[]> {
  const entries = await store.entries(scope);
  return entries
    .flatMap(({ value }) => (value?.version === 1 && value.card?.id ? [value.card] : []))
    .toSorted(compareCards);
}
