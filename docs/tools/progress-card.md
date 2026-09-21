---
summary: "Maintain one durable plan and status card for a session"
title: "Progress card"
sidebarTitle: "Progress card"
read_when:
  - You want an agent to publish durable at-a-glance progress for its current session
  - You need the progress_card input, limits, rendering, or clearing contract
---

`progress_card` is the single agent status tool for a session. It stores an ordered step plan, a compact Markdown note, or both. Each call replaces the whole card, so the latest write is the source of truth for someone following the work without reading the transcript.

The card belongs to the parent session the user is talking to and its agent. Spawned sub-agents never receive `progress_card` or its prompt reminder, including visible dashboard children and resumed children. Their results return to the parent, which owns progress updates. The tool binds the session and agent from the running session; the model only supplies `markdown` and `plan`.

The card is durable session state. A reconnect or page reload reads the latest card from the Gateway instead of reconstructing it from tool events or transcript history. The transcript keeps only a short update receipt, not another full copy of the card.

## Adoption

Create a card only for substantial work with at least two meaningful sequential steps. Skip greetings, quick questions, and single-step requests; do not invent steps to justify a card. The checklist remains optional: eligible work can use Markdown, a plan, or both. Existing cards can still be updated when progress meaningfully changes or cleared when requested.

OpenClaw adds a short progress-card reminder only for non-main, non-sub-agent sessions when a web, iOS, Android, or macOS card renderer is paired with the Gateway and the run is not using the agent's utility model. Channel-only deployments such as a WhatsApp-only Gateway do not receive the reminder.

The reminder says:

> Create a card with progress_card only for substantial work with at least two meaningful sequential steps, never for greetings, quick questions, or single-step requests. For measurable work with a known total, prefer a leading progress bar labeled with what is measured and observed completed/total counts; never invent percentages. Update or clear existing cards as needed.

The reminder does not override tool policy. `tools.updatePlan: false` or a matching `tools.deny` entry still removes `progress_card` from the run entirely.

## Update a card

Both input fields are optional:

- `plan`: up to 50 ordered steps. Each step has non-empty `step` text and a `status` of `pending`, `in_progress`, or `completed`. At most one step may be `in_progress`.
- `markdown`: a compact narrative about what happened, what is blocked, or what comes next. Use it when a glanceable note says more than the step list; do not repeat the plan in Markdown.

For batch work with a known total, prefer a leading progress bar:

```json
{
  "markdown": "<progress aria-label=\"PRs reviewed · 12/30\" value=\"12\" max=\"30\"></progress>\n\nTwo obsolete PRs closed. Verifying the next fix."
}
```

For genuinely sequential work, a checklist can show the current phase:

```json
{
  "plan": [
    { "step": "Inspect the failing route", "status": "completed" },
    { "step": "Repair the session owner", "status": "in_progress" },
    { "step": "Run focused verification", "status": "pending" }
  ],
  "markdown": "The failure is isolated to session ownership. No blocker."
}
```

Every call is a replacement, not a patch. Omitting `markdown` removes the previous note; omitting `plan` removes the previous checklist.

The tool returns a short receipt such as `Progress card updated (rev 4, 1/3 done)` or `Progress card updated (rev 4)` when there is no plan. Its structured result contains the revision and completed/total step counts, or `null` without a plan. Successful writes also update channel previews from the complete plan state. Failed or blocked writes leave the previous plan in place. Active channel previews retain a safe failure notice.

## Format the note

For eligible multi-step work with a known total, prefer a leading progress bar using observed completed/total counts: PRs reviewed, tests finished, files processed, or other meaningful work units. Prefer those counts over coarse phase counts such as "1 of 3 steps." Label exactly what the count measures: reviewed PRs are not merged PRs, and finished tests are not necessarily passing tests. Never invent percentages or infer completion from elapsed time. When the total is unknown, use a compact status note or table instead.

Follow the bar with a short result, blocker, or next action. Use tables for comparisons and a checklist only when the work is genuinely sequential. Omit the checklist when a table, bar, or sentence says it better, and do not repeat the same facts across the plan and Markdown. Update after meaningful batches or state changes, keeping the bar and its label current in every replacement. Markdown accepts ordinary formatting, links, and progress bars:

```md
<progress aria-label="Checks finished · 3/7" value="3" max="7"></progress>

Tests are running.

| check      | state   |
| ---------- | ------- |
| unit tests | passed  |
| live flow  | running |
```

Put one progress bar first and give it a short `aria-label` with its purpose and current/total values. In the session hovercard, the Agent Notepad pins the bar above the note and shows that label. Other raw HTML is stripped by the Markdown sanitizer.

## Limits

- Markdown: at most 8,192 UTF-8 bytes.
- Plan: at most 50 steps.
- Step text: non-empty and at most 512 UTF-8 bytes per step.
- Active work: at most one `in_progress` step.

The Gateway removes invisible Unicode and bidirectional control characters from Markdown and step text before storing the card.

## Clear a card

Call `progress_card` with both parts absent or empty to remove the current card:

```json
{}
```

An empty plan plus empty or whitespace-only Markdown also clears it. A successful clear returns `Progress card cleared`. Channel previews remove the checklist and its status, keep other activity, and delete an otherwise empty draft. A later card update can create a new draft.

A full in-place conversation reset (`/reset` without `soft`, or `sessions.reset`) also clears the previous task’s card. The clear commits with the reset boundary and refreshes subscribed clients; a fresh page load also sees no old card. Writes admitted before that reset cannot restore it. Reset preserves transcript history and dashboard layout. Automatic continuity resets that preserve prior context do not clear the card.

## Where the card appears

Channels with progress drafts show the latest checklist in active `partial`, `block`, and `progress` previews, subject to their preview settings and line limits. Cards with steps supply a completion count. Notes without steps supply readable text with Markdown formatting and authored HTML removed, subject to the existing headline limit. A note without readable text supplies `Progress updated`. The full Markdown remains in the durable card. Telegram uses native checkboxes with `channels.telegram.richMessages: true` and readable HTML checklists otherwise. See [Streaming and chunking](/concepts/streaming#progress-draft-rendering).

By default, the current chat keeps exactly one live card, in the collapsible surface inside the composer, at every width. Opening a side panel does not move it out of the conversation. The dashboard widget and the session hovercard are separate read-only placements: hover a session row in the sidebar or a session-reference link in chat to see the same card for that session. All card placements read the same Gateway-backed state and refresh after `progressCard.changed` notifications. A notification is a refresh hint, including a null revision; clients confirm a removal with a read or clear response for that session and agent.

In the Control UI, **Settings → Appearance → Chat → Show task progress cards** hides or shows the composer card. It is enabled by default and stored in this browser only. Turning it off also removes the loading placeholder, without stopping agent work, clearing saved progress, or changing dashboard widgets and session previews. Turn it back on to see the current card. The separate **Collapse task progress by default** preference is preserved while cards are hidden.

The composer card starts expanded for active work unless **Collapse task progress by default** is enabled. Mounting the card or switching sessions displays its initial state without a fold animation. While reading earlier messages, automatic collapse requires at least two upward scroll gestures totaling at least 320 pixels, followed by 300 milliseconds without scrolling. Wheel bursts separated by more than 200 milliseconds count separately; each touch drag counts as one gesture, including its inertia. Only upward movement consumed by the transcript counts; scrolling inside tool output, canceled input, and programmatic position adjustments do not. Returning to the bottom resets the counts.

Returning to the bottom and progress updates do not reopen an automatically collapsed card. The run completing can reopen it only if you are already at the bottom. Completion while reading history keeps it collapsed, even when you return to the bottom later.

Full open and closed choices are remembered per session in the current Gateway connection until the page reloads. Switching Gateway connections starts with a fresh choice. A manual close prevents automatic reopening. After your first manual reopen during a visit or run, continued upward scrolling can collapse the card again, with a higher threshold: three gestures and 640 pixels, followed by the same 300-millisecond pause. That collapse clears the remembered open choice. A second manual reopen stops automatic collapse for that visit and run. Leaving and returning to the chat, or starting a new run, restores the base thresholds while preserving remembered full open or closed choices.

Drag upward on the composer card’s header, or scroll upward while the pointer is over it, to reveal more of the panel. Move downward to close it. The panel follows the distance you move: stopping holds a partial opening, and reversing moves it back without a timed animation or release snap. This also works with a touch drag on the header. The note and checklist keep their normal scrolling and links.

Click the header, or focus it and press Enter or Space, to open or close the whole card. A partial opening expands fully on activation; an opening already showing the entire panel closes on the first activation, including when reached by a gesture.

A partial opening is a pixel-height choice for the current task: new output, card revisions, and the final response do not finish or undo it. Leaving and returning to that same task in the current Gateway connection retains the height; starting a genuinely new task discards it. Other sessions and Gateway connections do not inherit it. A smaller viewport clamps the retained height to the available panel space.

Taking over the header clears pending transcript-collapse gestures. Revealing a closed card counts as one manual reopen, not one per movement; subsequent genuine transcript gestures still follow the thresholds above. Direct manipulation also pauses transcript following; use **Latest** or scroll back toward the latest messages to resume. **Latest** does not change the chosen card height.

Transient refresh failures retain the last loaded card. The dashboard widget shows a retry notice until a refresh succeeds. If the Gateway reports that the connection no longer participates in the session, clients hide the card until access is restored and a refresh succeeds.

The composer and dashboard placements show the local time of the last progress update. The hovercard instead shows the current-or-next plan step and its completed/total count, followed by Markdown in a separate Agent Notepad when a note is present.

Without a matching terminal outcome, unfinished steps appear paused when the Gateway reports no active run or the card predates a later run. The last-update time shows when the agent last revised the card; elapsed time alone does not expire a card belonging to an active run.

## Refresh current work status

In the Control UI composer, select **Refresh task progress** beside the card’s timestamp to ask the agent to reconcile the card with its current work. The action remains available when the card is collapsed. It does not send a visible chat message.

While the request is pending, the previous card and its last-update time remain visible. The refresh is confirmed only after the Gateway returns a newer saved card. If the request fails or takes too long, use the retry action; a timeout does not cancel running work.

An active agent receives the request at its next supported steering boundary without interrupting a running tool or answering a pending question. If steering is unavailable, the request waits for a status-only turn. An idle agent can update the card with read-only context tools and `progress_card`; refreshing does not authorize it to resume stopped work or change the task goal. The control request and standalone refresh output remain hidden from chat, including reloaded history. Normal replies from an already-active task remain visible.

The action uses the session’s existing write permissions. Dashboard and hovercard placements remain read-only.

## Gateway requests

`progressCard.get`, `progressCard.put`, and `progressCard.refresh` accept a required `sessionKey` and optional `agentId`. Pass both when selecting an agent explicitly, for example `{ "sessionKey": "global", "agentId": "research" }`. Omitting `agentId` retains the Gateway's existing session-owner resolution. An unknown agent or an agent that conflicts with the session owner is rejected.

Keep the original session and agent together for subsequent reads and clears. The returned card and change event use an agent-qualified display key; that key alone cannot distinguish a retained `global` session from an ordinary session whose key is `agent:<agentId>:global`. All three methods use the selected session’s normal access checks, in addition to their operator read or write scope.

`progressCard.refresh` also requires an `idempotencyKey` and an existing card. It accepts no prompt text. Its `{ runId, status: "accepted", revision }` response acknowledges the request and identifies the baseline revision; it does not mean the card was updated. Clients confirm a newer card through the existing change event and read path.

The Control UI ships with its Gateway and follows the captured session owner without version negotiation: ordinary agent-qualified keys omit redundant `agentId`, while raw targets retain their explicit owner. Gateways also advertise `progress-card-agent-scope-v1` in `hello.features.capabilities` for independently upgraded clients, such as native apps. Those clients check the capability before sending `agentId`: ordinary agent-qualified keys can omit the field, while a canonical `global` target with an explicit owner requires it. If that capability is missing, the independently upgraded client reports that a Gateway update is needed.

## Pin the card to the dashboard

Use the `dashboard` tool to keep the live card on the current session's dashboard:

```json
{
  "action": "widget_put",
  "name": "session-progress",
  "title": "Session progress",
  "pluginKind": "session:progress",
  "size": "md"
}
```

Omit `props.sessionKey` to follow the dashboard's session. To show another session's card, add `"props": { "sessionKey": "agent:main:release" }`. The current connection must participate in that session; otherwise select an accessible session or change its sharing.

## Related

- [Tools overview](/tools)
- [`openclaw dashboard`](/cli/dashboard) — open the Control UI from the CLI
- [Control UI URLs](/web/urls) — reaching the Control UI in a browser
