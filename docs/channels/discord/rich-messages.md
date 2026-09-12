---
summary: "Components v2 containers, interactive component payloads, and exec approvals in Discord"
read_when:
  - Sending buttons, selects, or other Discord components from an agent
  - Approving exec requests from inside Discord
title: "Discord components and approvals"
sidebarTitle: "Components and approvals"
---

Rich Discord message surfaces: components v2 containers, interaction handling, and approval prompts.

## Interactive components

OpenClaw supports Discord components v2 containers for agent messages. Use the message tool with a `components` payload. Interaction results route back to the agent as normal inbound messages and follow the existing Discord `replyToMode` settings.

`components` is a Discord-specific extension to the shared message tool. OpenClaw exposes it whenever Discord is configured, including when another channel is current. Use `presentation` when the same rich message must work across channels; OpenClaw adapts portable presentation actions to each target.

Supported blocks:

- `text`, `section`, `separator`, `actions`, `media-gallery`, `file`
- Action rows allow up to 5 buttons or a single select menu
- Buttons support emoji, including link buttons
- Select types: `string`, `user`, `role`, `mentionable`, `channel`

By default, components are single use. Set `components.reusable=true` to allow buttons, selects, and forms to be used multiple times until they expire.

To restrict who can click a button, set `allowedUsers` on that button (Discord user IDs, tags, or `*`). Unmatched users receive an ephemeral denial.

Component callbacks expire after 30 minutes by default. Set `channels.discord.agentComponents.ttlMs` to change the callback registry lifetime for the default account, or `channels.discord.accounts.<accountId>.agentComponents.ttlMs` per account. The value is milliseconds, must be a positive integer, and is capped at `86400000` (24 hours). Longer TTLs suit review/approval workflows that need buttons to stay usable, but they extend the window in which an old Discord message can still trigger an action. Prefer the shortest TTL that fits, and keep the default when stale callbacks would be surprising.

The `/model` and `/models` slash commands open an interactive model picker with provider, model, and compatible runtime dropdowns plus a Submit step. `/models add` is deprecated and returns a deprecation message instead of registering models from chat. The picker reply is ephemeral and only usable by the invoking user. Discord select menus are limited to 25 options, so add `provider/*` entries to `agents.defaults.modelPolicy.allow` when you want the picker to show dynamically discovered models only for selected providers such as `openai` or `vllm`.

File attachments:

- `file` blocks must point to an attachment reference (`attachment://<filename>`)
- Provide the attachment via `media`/`path`/`filePath` (single file); use `media-gallery` for multiple files
- Use `filename` to override the upload name when it should match the attachment reference
- Attachment captions preserve text-block order and repeated paragraphs

Modal forms:

- Add `components.modal` with up to 5 fields
- Field types: `text`, `checkbox`, `radio`, `select`, `role-select`, `user-select`
- OpenClaw adds a trigger button automatically

Example:

```json5
{
  channel: "discord",
  action: "send",
  to: "channel:123456789012345678",
  message: "Optional fallback text",
  components: {
    reusable: true,
    text: "Choose a path",
    blocks: [
      {
        type: "actions",
        buttons: [
          {
            label: "Approve",
            style: "success",
            allowedUsers: ["123456789012345678"],
          },
          { label: "Decline", style: "danger" },
        ],
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder: "Pick an option",
          options: [
            { label: "Option A", value: "a" },
            { label: "Option B", value: "b" },
          ],
        },
      },
    ],
    modal: {
      title: "Details",
      triggerLabel: "Open form",
      fields: [
        { type: "text", label: "Requester" },
        {
          type: "select",
          label: "Priority",
          options: [
            { label: "Low", value: "low" },
            { label: "High", value: "high" },
          ],
        },
      ],
    },
  },
}
```

## Components v2 UI

OpenClaw uses Discord components v2 for exec approvals and cross-context markers. Discord message actions can also accept `components` for custom UI (advanced; requires constructing a component payload via the discord tool), while legacy `embeds` remain available but are not recommended.

- `channels.discord.agentComponents.ttlMs` controls how long sent Discord component callbacks remain registered (default `1800000`, maximum `86400000`). Per account: `channels.discord.accounts.<id>.agentComponents.ttlMs`.
- `embeds` are ignored when components v2 are present.
- Plain URL previews are suppressed by default. Set `suppressEmbeds: false` on a message action when a single outbound link should expand.

## Approvals

<AccordionGroup>
  <Accordion title="Approvals in Discord">
    Discord supports button-based approval handling in DMs and can optionally post approval prompts in the originating channel.

    Config path:

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers` (optional; falls back to `commands.ownerAllowFrom` when possible)
    - `channels.discord.execApprovals.target` (`dm` | `channel` | `both`, default: `dm`)
    - `agentFilter`, `sessionFilter`, `cleanupAfterResolve`

    Discord native exec approvals require `enabled: true` or `enabled: "auto"` and at least one resolved approver, either from `execApprovals.approvers` or from `commands.ownerAllowFrom`. Leaving `enabled` unset or setting it to `false` disables native exec approval delivery. Discord does not infer exec approvers from channel `allowFrom`, legacy `dm.allowFrom`, or direct-message `defaultTo`.

    For sensitive owner-only group commands such as `/diagnostics` and `/export-trajectory`, OpenClaw sends approval prompts and final results privately. It tries Discord DM first when the invoking owner has a Discord owner route; otherwise it falls back to the first available owner route from `commands.ownerAllowFrom`, such as Telegram.

    When `target` is `channel` or `both`, the approval prompt is visible in the channel. Only resolved approvers can use the buttons; other users receive an ephemeral denial. Approval prompts include the command text, so only enable channel delivery in trusted channels. If the channel ID cannot be derived from the session key, OpenClaw falls back to DM delivery.

    Discord renders the shared approval buttons used by other chat channels; the native Discord adapter mainly adds approver DM routing and channel fanout. When those buttons are present, they are the primary approval UX; OpenClaw should only include a manual `/approve` command when the tool result says chat approvals are unavailable or manual approval is the only path. If the Discord native approval runtime is not active, OpenClaw keeps the local deterministic `/approve <id> <decision>` prompt visible. If the runtime is active but a native card cannot be delivered to any target, OpenClaw sends a same-chat fallback notice with the exact `/approve` command from the pending approval.

    Gateway auth and approval resolution follow the shared Gateway client contract (`plugin:` IDs resolve through `plugin.approval.resolve`; other IDs through `exec.approval.resolve`). Approvals expire after 30 minutes by default.

    See [Exec approvals](/tools/exec-approvals).

  </Accordion>
</AccordionGroup>
