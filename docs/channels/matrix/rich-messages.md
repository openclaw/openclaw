---
summary: "Structured reply controls, approval event metadata, and exec approval prompts"
read_when:
  - Rendering buttons or selection lists in a Matrix client
  - Delivering exec approvals through Matrix
title: "Matrix rich messages and approvals"
sidebarTitle: "Rich messages"
---

Structured content OpenClaw attaches to Matrix events, and the approval prompts built on it.

## Reply controls and presentations

Buttons and selection lists in agent replies include readable fallback text and
structured content under `com.openclaw.presentation`. Stock Matrix clients show
the text; OpenClaw-aware clients can render the structured controls. Replies that
contain only controls still produce a room message.

For replies with multiple attachments, the first event carries the controls.
Streamed replies retain them in the finalized edit. When a table or chart cannot
be rendered natively, an authored text fallback is preserved.

## Approval metadata

Matrix native approval prompts are normal `m.room.message` events with OpenClaw-specific content under the `com.openclaw.approval` key. Stock clients still render the text body; OpenClaw-aware clients can read the structured approval id, kind, state, decisions, and exec/plugin details.

When a prompt is too long for one Matrix event, OpenClaw chunks the visible text and attaches `com.openclaw.approval` to the first chunk only. Allow/deny reactions bind to that first event, so long prompts keep the same approval target as single-event prompts.

### Self-hosted push rules for quiet finalized previews

`streaming.mode: "quiet"` only notifies recipients once a block or turn is finalized - a per-user push rule must match the finalized preview marker. See [Matrix push rules for quiet previews](/channels/matrix-push-rules) for the full recipe.

## Exec approvals

Matrix can act as a native approval client. Configure under `channels.matrix.execApprovals` (or `channels.matrix.accounts.<account>.execApprovals` for a per-account override):

- `enabled`: deliver approvals through Matrix-native prompts. Unset or `"auto"` auto-enables once at least one approver can be resolved; set `false` to disable explicitly.
- `approvers`: Matrix user IDs (`@owner:example.org`) allowed to approve exec requests. Falls back to `channels.matrix.dm.allowFrom`.
- `target`: where prompts go. `"dm"` (default) sends to approver DMs; `"channel"` sends to the originating room or DM; `"both"` sends to both.
- `agentFilter` / `sessionFilter`: optional allowlists for which agents/sessions trigger Matrix delivery.

Authorization differs slightly between approval kinds:

- **Exec approvals** use `execApprovals.approvers`, falling back to `dm.allowFrom`.
- **Plugin approvals** authorize through `dm.allowFrom` only.

Both kinds share Matrix reaction shortcuts and message updates. Approvers see reaction shortcuts on the primary approval message:

- ✅ allow once
- ❌ deny
- ♾️ allow always (when the effective exec policy allows it)

Fallback slash commands: `/approve <id> allow-once`, `/approve <id> allow-always`, `/approve <id> deny`.

Only resolved approvers can approve or deny. Channel delivery for exec approvals includes the command text - only enable `channel` or `both` in trusted rooms.

Related: [Exec approvals](/tools/exec-approvals).
