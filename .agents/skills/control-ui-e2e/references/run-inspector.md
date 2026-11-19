# Run Inspector evidence

- Collect with `withControlUiRunInspector` from `ui/src/test-helpers/control-ui-run-inspector.ts`.
  Owns separate page; closes on success/failure; leaves caller's Chat page + unsent
  draft in place.
- `preparePage`: mock Gateway or campaign's existing per-tab authentication setup.
  Shared browser context does not copy another tab's session-storage token.
- Helper uses rendered component model's `RunInspectorSelector` +
  `activityRunInspectorSelectorHref`, including selected receipt's decision cursor.
- Rendered panel's `data-run-id` + `data-execution-id`: returned present identity,
  not just requested URL. Selected detail's `data-receipt-selector-id` =
  `DecisionReceiptDisplayV1.selectorId`.
- Count a match only when the rendered identity is unambiguous and the selected
  receipt is present.
- Decision selectors separate from optional terminal transcript key
  `agent.wait.terminalReceipt.assistantTranscriptIdempotencyKey`. Never manufacture
  key from DOM selector/history row or claim Inspector evidence repairs its absence.
- Sidebar run state's accessible label: `Active run`.

**Done:** the captured panel's identity and selected receipt match the requested
run/execution, and the original Chat page and unsent draft remain intact. Report
missing or ambiguous evidence explicitly.
