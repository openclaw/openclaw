/** Shared store presentation helpers for the Stores & sharing views. */
import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import { t } from "./i18n/index.js";
import type { StoreEntry } from "./stores-contract.js";
import type { IconName } from "./ui-icons.js";

export type Snapshot = FeatureOutput<typeof contract, "stores_snapshot">;
/** Display name for an agent ID (host roster first). */
export type Names = (agentId: string) => string;

/** "A", "A and B", "A, B and C". */
export const andList = (xs: string[]) =>
  xs.length <= 1
    ? xs.join("")
    : t("knowledge.common.andList", { items: xs.slice(0, -1).join(", "), last: xs.at(-1)! });

/** Label for a store: named stores by name, isolated stores by owner. */
export const storeLabel = (entry: StoreEntry, names: Names) =>
  entry.kind === "named"
    ? entry.label
    : t("knowledge.stores.ownStore", { agent: names(entry.owner!) });
/** The store an agent currently uses, if its assignment is valid. */
export const storeOf = (snapshot: Snapshot, agentId: string) => {
  const binding = snapshot.agents.find((a) => a.id === agentId)?.binding;
  return binding ? snapshot.stores.find((s) => s.binding === binding) : undefined;
};
/** "Shared with Research", "No other agents" or "Not shared". */
export function accessText(entry: StoreEntry, agentId: string, names: Names) {
  if (entry.kind === "isolated") {
    return t("knowledge.stores.notShared");
  }
  const others = entry.members.filter((a) => a !== agentId);
  return others.length
    ? t("knowledge.stores.sharedWith", { agents: andList(others.map(names)) })
    : t("knowledge.stores.noOtherAgents");
}
/** Record count or lifecycle; unknown counts stay unknown, never zero. */
export function recordsText(entry: StoreEntry) {
  switch (entry.state) {
    case "unprovisioned":
      return t("knowledge.stores.states.unprovisioned");
    case "initializing":
      return t("knowledge.stores.states.initializing");
    case "unavailable":
      return t("knowledge.stores.states.unavailable");
    case "recovery-required":
      return t("knowledge.stores.states.recovery");
    default:
      return entry.records === null
        ? ""
        : entry.records === 0
          ? t("knowledge.stores.states.empty")
          : t(entry.records === 1 ? "knowledge.stores.recordOne" : "knowledge.stores.records", {
              count: entry.records.toLocaleString(),
            });
  }
}
/** Icon for a store: shared stores show people, isolated stores one person. */
export const storeIcon = (entry: StoreEntry | undefined): IconName =>
  entry?.kind === "named" ? "users" : "circleUser";
