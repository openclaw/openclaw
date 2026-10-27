import type { BrowserActRequest } from "./client-actions.types.js";

export type ActKind = BrowserActRequest["kind"];

type BrowserActKindFacts = {
  hidden?: true;
  capability?: "supportsBatchActions" | "supportsVisualActions";
  lightpanda?: true;
  selector?: true;
  timeout?: "default" | "explicit";
  existingSessionTimeout?: true;
};

// Insertion order is the model-facing enum order; insertText remains API-only.
export const BROWSER_ACT_KIND_FACTS: Record<ActKind, BrowserActKindFacts> = {
  batch: { capability: "supportsBatchActions", selector: true },
  click: { lightpanda: true, selector: true, timeout: "default", existingSessionTimeout: true },
  clickCoords: {
    capability: "supportsVisualActions",
    timeout: "explicit",
    existingSessionTimeout: true,
  },
  type: { lightpanda: true, selector: true, timeout: "default" },
  press: { lightpanda: true },
  hover: { capability: "supportsVisualActions", selector: true, timeout: "default" },
  scrollIntoView: { capability: "supportsVisualActions", selector: true, timeout: "default" },
  drag: { capability: "supportsVisualActions", selector: true, timeout: "default" },
  select: { lightpanda: true, selector: true, timeout: "default" },
  fill: { lightpanda: true, timeout: "default" },
  resize: { capability: "supportsVisualActions" },
  wait: { lightpanda: true, selector: true, timeout: "default", existingSessionTimeout: true },
  evaluate: { lightpanda: true, timeout: "default", existingSessionTimeout: true },
  close: { lightpanda: true },
  insertText: { hidden: true },
};

// SAFETY: The closed table declares every ActKind and contains no additional keys.
export const BROWSER_MODEL_ACT_KINDS = (Object.keys(BROWSER_ACT_KIND_FACTS) as ActKind[]).filter(
  (kind): kind is Exclude<ActKind, "insertText"> => !BROWSER_ACT_KIND_FACTS[kind].hidden,
);

export function isActKind(value: unknown): value is ActKind {
  return typeof value === "string" && Object.hasOwn(BROWSER_ACT_KIND_FACTS, value);
}
