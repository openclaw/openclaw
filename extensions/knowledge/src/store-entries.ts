/** Shared store presentation helpers for the Stores & sharing views. */
import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import type { StoreEntry } from "./stores-contract.js";
import type { IconName } from "./ui-icons.js";

export type Snapshot = FeatureOutput<typeof contract, "stores_snapshot">;
export type ChangeResult = FeatureOutput<typeof contract, "stores_change">;
/** Display name for an agent ID (host roster first). */
export type Names = (agentId: string) => string;

/** Element with optional text content and class name. */
export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) => {
  const n = document.createElement(tag);
  if (text !== undefined) {
    n.textContent = text;
  }
  if (className) {
    n.className = className;
  }
  return n;
};
/** Plain button running `run` on click. */
export const button = (text: string, run: () => void, className = "knowledge-button") => {
  const n = el("button", text, className);
  n.type = "button";
  n.addEventListener("click", run);
  return n;
};
/** "A", "A and B", "A, B and C". */
export const andList = (xs: string[]) =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** Label for a store: named stores by name, isolated stores by owner. */
export const storeLabel = (entry: StoreEntry, names: Names) =>
  entry.kind === "named" ? entry.label : `${names(entry.owner!)}’s knowledge`;
/** The store an agent currently uses, if its assignment is valid. */
export const storeOf = (snapshot: Snapshot, agentId: string) => {
  const binding = snapshot.agents.find((a) => a.id === agentId)?.binding;
  return binding ? snapshot.stores.find((s) => s.binding === binding) : undefined;
};
/** "Shared with Research", "No other agents" or "Not shared". */
export function accessText(entry: StoreEntry, agentId: string, names: Names) {
  if (entry.kind === "isolated") {
    return "Not shared";
  }
  const others = entry.members.filter((a) => a !== agentId);
  return others.length ? `Shared with ${andList(others.map(names))}` : "No other agents";
}
/** Record count or lifecycle; unknown counts stay unknown, never zero. */
export function recordsText(entry: StoreEntry) {
  switch (entry.state) {
    case "unprovisioned":
      return "Created on first use";
    case "initializing":
      return "Being created";
    case "unavailable":
      return "Couldn’t be opened";
    case "recovery-required":
      return "Needs recovery";
    default:
      return entry.records === null
        ? ""
        : entry.records === 0
          ? "Empty"
          : `${entry.records.toLocaleString()} record${entry.records === 1 ? "" : "s"}`;
  }
}
/** Icon for a store: shared stores show people, isolated stores one person. */
export const storeIcon = (entry: StoreEntry | undefined): IconName =>
  entry?.kind === "named" ? "users" : "circleUser";
