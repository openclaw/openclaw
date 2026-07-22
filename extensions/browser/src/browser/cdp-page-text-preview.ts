/**
 * Surrogate-safe CDP transport truncate for Runtime.evaluate page scope.
 *
 * Injected via Function#toString into the browser page. Must stay
 * dependency-free: Node/SDK helpers (truncateUtf16Safe) throw ReferenceError
 * in page scope and fail findCursorInteractiveElements closed to an empty map.
 *
 * == CDP transport hardening ==
 *
 * The legacy two-stage pipeline (page `.slice(0, 101)` → Node
 * `truncateUtf16Safe(_, 100)`) already produces safe final cursor text because
 * the Node step re-cuts the string past the lone-surrogate position.
 * However, the intermediate value crossing CDP `returnByValue` carries a
 * malformed code unit — a lone high surrogate — which is itself a violation of
 * the UTF-16 invariant on the wire.
 *
 * This helper owns the cut **inside the page, before** `returnByValue`
 * serialises the result.  The Node `truncateUtf16Safe` cap is kept as
 * defense-in-depth for any evaluator payload that slips through with an odd
 * length budget.
 *
 * Stronger than a split-pair-only cut: any trailing high surrogate at the
 * budget end is dropped — both mid-emoji cuts **and** lone high units left by
 * unsafe `.slice` residues.  Do not inject `truncateUtf16Safe.toString()`;
 * it closes over `sliceUtf16Safe`/surrogate helpers in normalization-core.
 */
export function truncateCdpPageTextPreview(text: string, maxLen: number): string {
  const limit = Math.max(0, Math.floor(maxLen));
  let end = Math.min(text.length, limit);
  if (end > 0) {
    const unit = text.charCodeAt(end - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      end -= 1;
    }
  }
  return text.slice(0, end);
}
