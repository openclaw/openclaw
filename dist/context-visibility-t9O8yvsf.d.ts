import { d as ContextVisibilityMode } from "./types.base-DS--yneR.js";

//#region src/security/context-visibility.d.ts
type ContextVisibilityKind = "history" | "thread" | "quote" | "forwarded";
type ContextVisibilityDecisionReason = "mode_all" | "sender_allowed" | "quote_override" | "blocked";
type ContextVisibilityDecision = {
  include: boolean;
  reason: ContextVisibilityDecisionReason;
};
declare function evaluateSupplementalContextVisibility(params: {
  mode: ContextVisibilityMode;
  kind: ContextVisibilityKind;
  senderAllowed: boolean;
}): ContextVisibilityDecision;
declare function shouldIncludeSupplementalContext(params: {
  mode: ContextVisibilityMode;
  kind: ContextVisibilityKind;
  senderAllowed: boolean;
}): boolean;
declare function filterSupplementalContextItems<T>(params: {
  items: readonly T[];
  mode: ContextVisibilityMode;
  kind: ContextVisibilityKind;
  isSenderAllowed: (item: T) => boolean;
}): {
  items: T[];
  omitted: number;
};
//#endregion
export { filterSupplementalContextItems as a, evaluateSupplementalContextVisibility as i, ContextVisibilityDecisionReason as n, shouldIncludeSupplementalContext as o, ContextVisibilityKind as r, ContextVisibilityDecision as t };