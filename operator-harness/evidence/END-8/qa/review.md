# QA Review - END-8

- Result: **PASS**
- Reviewer role: `qa`
- Validation command: `node --import tsx /Users/clankinbot/Code/openclaw/operator-harness/scripts/run-artifact-walkthrough.ts --task /Users/clankinbot/Code/openclaw/.local/operator-harness/workspaces-v2/END-8/qa/.openclaw-operator/task-qa.json`
- Evidence directory: `operator-harness/evidence/END-8/qa`

## Exact checks performed

1. Opened `http://127.0.0.1:42124/pilot/` and waited for load.
2. Asserted `[data-testid='pilot-home-title']` contains `Pilot Home`.
3. Asserted `[data-testid='pilot-dashboard-card-source-health-title']` contains `Source pack health`.
4. Clicked `[data-testid='pilot-home-new-project']` and waited for load.
5. Filled `[data-testid='pilot-project-parcel-input']` with `APN 123-456-789`.
6. Filled `[data-testid='pilot-project-address-input']` with `100 Main St, Austin, TX`.
7. Filled `[data-testid='pilot-project-scope-input']` with `Civil entitlement due diligence`.
8. Clicked `[data-testid='pilot-project-create']`.
9. Asserted `[data-testid='pilot-project-summary-title']` contains `Pilot project created`.
10. Asserted `[data-testid='pilot-project-launch-chat']` contains `Launch project workspace`.
11. Verified generated artifacts: `before.png`, `after.png`, `annotated.png`, `walkthrough.webm`, `serve.log`.
12. Spot-checked generated screenshots for expected dashboard framing and created-project summary content.

## Regression risk

- Low to medium: this walkthrough validates the primary `/pilot` home-to-project creation flow and key text assertions only.
- Residual risk remains for non-happy paths (validation errors, alternate viewport/responsive behavior, and deeper workspace navigation beyond the launch link).
