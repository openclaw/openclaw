## Summary

Implement END-7 and collect the required MVP evidence.

## Upstream

- Linear: https://linear.app/endeavorship-ai/issue/END-7/pilot-shell-and-parcel-intake-on-clean-main
- Notion: https://www.notion.so/Construction-Knowledge-Platform-Storyboard-Hub-3182cb8d0fb481c08f55c19d7c9bd4f5
- Notion: https://www.notion.so/3182cb8d0fb4818c8f4fd32a892f22a8
- Notion: https://www.notion.so/3182cb8d0fb481969088c2e2b13f1a8d
- Notion: https://www.notion.so/Moore-Bass-02-Pilot-Home-Dashboard-3182cb8d0fb4818c8f4fd32a892f22a8
- Notion: https://www.notion.so/Moore-Bass-03-New-Pilot-Project-Setup-3182cb8d0fb481969088c2e2b13f1a8d

## Acceptance Criteria

- A dedicated `/pilot` shell exists on clean `main`.
- `/pilot/project` captures parcel ID, address, and project scope.
- `project`, `parcel`, and `jurisdiction` persist separately from generic chats.
- Pilot project context can launch and reuse the existing chat/runner stack.
- [Screen 02 - Pilot Home Dashboard](https://www.notion.so/3182cb8d0fb4818c8f4fd32a892f22a8): canonical visual for the `/pilot` landing shell, dashboard cards, and blocked-work framing.
- [Screen 03 - New Pilot Project Setup](https://www.notion.so/3182cb8d0fb481969088c2e2b13f1a8d): canonical visual for parcel, address, and project-scope intake.

## Validation

- Startup: `if [ ! -d node_modules ]; then pnpm install --frozen-lockfile; fi; pnpm ui:dev --host 127.0.0.1 --port 41566`
- Healthcheck: http://127.0.0.1:41566/pilot/
- 1. open => http://127.0.0.1:41566/pilot/
- 2. wait_load
- 3. assert_text [data-testid='pilot-home-title'] => Pilot Home
- 4. assert_text [data-testid='pilot-dashboard-card-source-health-title'] => Source pack health
- 5. click [data-testid='pilot-home-new-project']
- 6. wait_load
- 7. fill [data-testid='pilot-project-parcel-input'] => APN 123-456-789
- 8. fill [data-testid='pilot-project-address-input'] => 100 Main St, Austin, TX
- 9. fill [data-testid='pilot-project-scope-input'] => Civil entitlement due diligence
- 10. click [data-testid='pilot-project-create']
- 11. assert_text [data-testid='pilot-project-summary-title'] => Pilot project created
- 12. assert_text [data-testid='pilot-project-launch-chat'] => Launch project workspace

## Evidence

### before.png

![before.png](https://raw.githubusercontent.com/openclaw/openclaw/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/before.png)
[Open before.png](https://github.com/openclaw/openclaw/blob/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/before.png)

### after.png

![after.png](https://raw.githubusercontent.com/openclaw/openclaw/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/after.png)
[Open after.png](https://github.com/openclaw/openclaw/blob/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/after.png)

### annotated.png

![annotated.png](https://raw.githubusercontent.com/openclaw/openclaw/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/annotated.png)
[Open annotated.png](https://github.com/openclaw/openclaw/blob/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/annotated.png)

### walkthrough.gif

![walkthrough.gif](https://raw.githubusercontent.com/openclaw/openclaw/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/walkthrough.gif)
[Open walkthrough.gif](https://github.com/openclaw/openclaw/blob/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/walkthrough.gif)

### walkthrough.webm

<video src="https://raw.githubusercontent.com/openclaw/openclaw/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/walkthrough.webm" controls muted playsinline width="960"></video>
[Open walkthrough.webm](https://github.com/openclaw/openclaw/blob/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/walkthrough.webm)

### review.md

[Open review.md](https://github.com/openclaw/openclaw/blob/codex%2Fend-7-pilot-shell-and-parcel-intake-on-clean-main/operator-harness/evidence/END-7/builder/review.md)
