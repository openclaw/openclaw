import type { OcAst } from "./universal.js";

export type Slot = "section" | "item" | "field";

export interface SlotSub {
  readonly slot: Slot;
  readonly value: string;
}

export type OnMatch = (subs: readonly SlotSub[]) => void;

export interface WalkContext {
  onMatch: OnMatch;
  visited: WeakMap<object, Set<string>>;
  kind: OcAst["kind"];
}
