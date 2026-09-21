import type { WorkboardCard } from "@openclaw/workboard-contract";
import type {
  PersistedWorkboardCard,
  WorkboardCardReadScope,
  WorkboardCardStore,
} from "./persistence-types.js";
import { compareCards } from "./store-card-helpers.js";

export async function readCards(
  store: WorkboardCardStore,
  scope?: WorkboardCardReadScope,
): Promise<WorkboardCard[]> {
  const entries = await store.entries(scope);
  return entries
    .map((entry) => entry.value)
    .filter(
      (entry): entry is PersistedWorkboardCard => entry?.version === 1 && Boolean(entry.card?.id),
    )
    .map((entry) => entry.card)
    .toSorted(compareCards);
}
