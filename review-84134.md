# Review: Issue #84134 — Transcript Repair Prefer Real Result

## Summary

The fix adds logic to `repairToolUseResultPairing` so that when duplicate `toolResult` entries exist for the same tool call ID, a real result replaces a previously-seen synthetic "missing tool result" placeholder instead of being silently dropped. Changes are in two code paths (top-level `pushToolResult` and span-level collection) plus five new tests.

---

## 1. Synthetic Detection (`isSyntheticMissingToolResult`)

**Correct for the default text path.** The function checks `isError === true`, then scans content blocks for any text containing `"[openclaw] missing tool result"`. This matches the default string produced by `makeMissingToolResult`.

**Gap with custom `missingToolResultText`.** When callers pass `missingToolResultText: "aborted"` (OpenAI Responses/Codex path) or `"No result provided"`, the resulting synthetic does not contain the `[openclaw] missing tool result` marker. `isSyntheticMissingToolResult` will return `false` for these, meaning the preference logic won't fire — the real result would still be dropped as a duplicate.

In practice this may be acceptable because:

- The `"aborted"` path runs through `transport-message-transform.ts` for fresh API submissions, not session history repair of persisted transcripts.
- Session history repair typically uses the default text.

**Recommendation:** Document this limitation with a brief comment on `isSyntheticMissingToolResult`, or widen detection to also check `isError === true` + content matching any of the known synthetic texts. At minimum, acknowledge the gap explicitly.

## 2. Preference Logic (Real > Synthetic)

**Top-level `pushToolResult` (lines 507–525):** When a duplicate ID is seen, the code looks up the existing entry's position in `out`, checks if it's synthetic, and if the incoming message is real, replaces it in-place via `out[existingIdx] = msg`. This is correct: the real result takes the same position in the output array, maintaining message ordering.

**Span-level collection (lines 612–621):** Within the span loop, if `spanResultsById` already has a synthetic for an ID and a real result arrives, the map entry is replaced. Correct — later when results are pushed via `pushToolResult`, the real one is what gets emitted.

**Both paths correctly set `changed = true`** to ensure the caller knows the transcript was modified.

## 3. Edge Cases

| Scenario                     | Expected                       | Covered by test |
| ---------------------------- | ------------------------------ | --------------- |
| Synthetic first, real second | Keep real                      | Yes             |
| Real first, synthetic second | Keep real                      | Yes             |
| Both real                    | Keep first (existing behavior) | Yes             |
| Both synthetic               | Keep first (existing behavior) | Yes             |
| Span-level synthetic→real    | Keep real                      | Yes             |

All four edge cases plus the span variant are tested. The "both real → keep first" test confirms the fix doesn't accidentally change the existing first-wins deduplication for non-synthetic cases.

**Missing edge case:** A test where the synthetic has custom text (e.g., `missingToolResultText: "aborted"`) and a real result appears afterward would explicitly document the detection gap mentioned above.

## 4. First-Seen Behavior for Non-Duplicates

Unchanged. When `id` is not in `seenToolResultIds`, the code falls through to the existing `seenToolResultIds.add(id)` + `out.push(msg)` path (lines 531–535). The new `toolResultPositions.set(id, out.length)` is added on the same branch — it's a parallel data structure, not a behavioral change.

## 5. Test Quality

Tests are well-structured:

- Helper factories (`makeSyntheticResult`, `makeRealResult`, `makeAssistant`) keep tests readable.
- Each test asserts on specific properties (`isError`, `content[0].text`) rather than doing snapshot comparisons.
- The `castAgentMessages` utility handles type coercion.

**Suggestions:**

- Add a test asserting `result.droppedDuplicateCount` is 0 when a synthetic-to-real replacement happens (the current code does not increment the counter in the replacement path, which is arguably correct but should be verified).
- The `added` array cleanup (`added.splice(addedIdx, 1)`) is tested implicitly but a test asserting `result.added.length === 0` after replacement would make the bookkeeping behavior explicit.

## 6. Impact on Other Transcript Repair Scenarios

**Low risk.** The changes are narrowly scoped:

- `pushToolResult` only enters the new branch when `seenToolResultIds.has(id)` is true AND the existing entry is synthetic AND the new one is real. All other duplicate handling falls through to the existing `droppedDuplicateCount += 1` path.
- The span-level change is similarly guarded: it only replaces when the existing is synthetic and the new one is not.
- The `toolResultPositions` map is purely additive infrastructure with no effect on non-duplicate paths.

**One concern:** The `added` array cleanup in `pushToolResult` (lines 519–522) uses a linear scan. With many synthetic results this could be O(n²), but in practice transcript repair operates on bounded message counts — not a real performance issue.

## 7. String Matching Robustness

The detection uses `.includes("[openclaw] missing tool result")` — a substring match against a prefix of the full marker string. This is:

- **Robust against minor suffix changes** to the default text.
- **Fragile if the prefix is changed**, but since `makeMissingToolResult` is the only producer and lives in the same file, the coupling is acceptable.
- **Not robust against custom `missingToolResultText`** (see item 1).

The test file hardcodes the full default string as `SYNTHETIC_TEXT` rather than importing/reusing the constant from production code. If the marker text changes, the test would still pass with the old string, silently diverging. Consider extracting the marker prefix as a named constant shared between the detector and the factory.

---

## Verdict

**Approve with minor suggestions.** The core logic is correct and well-tested for the default-text path. The fix is narrowly scoped and won't regress other repair scenarios.

### Action items (non-blocking)

1. **Document or widen** `isSyntheticMissingToolResult` to acknowledge the custom-text gap.
2. **Extract** the `"[openclaw] missing tool result"` marker as a named constant shared between `makeMissingToolResult` and `isSyntheticMissingToolResult`.
3. **Add a test** for the custom `missingToolResultText` path (even if just to document current behavior — "custom-text synthetic is NOT replaced").
4. **Add assertions** for `droppedDuplicateCount` and `added.length` in the replacement tests to lock down bookkeeping behavior.
