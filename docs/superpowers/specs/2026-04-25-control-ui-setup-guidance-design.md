# Control UI Setup Guidance Design

## Summary

Add inline setup guidance anywhere the Control UI currently indicates a setup-blocked state for skills or channels.

Simple setup should show a single visible line with a copy action for the exact command or snippet when one exists.

Complex setup should use the same first line plus an expandable detail block that stays hidden until the user explicitly opens it.

The feature is design-scoped only in this document. No implementation or release changes are included here.

## Goals

- Replace vague `Needs setup` states with one actionable setup line.
- Prefer copyable commands or snippets over docs-only guidance.
- Keep setup truth close to existing skill and channel setup owners.
- Use one visual pattern across both `Skills` and `Channels`.
- Preserve current behavior for plugins or skills that do not opt into richer guidance.

## Non-Goals

- No new standalone setup wizard or modal.
- No changes to channel onboarding flow behavior.
- No changes to skill installation behavior.
- No attempt to fully normalize all channel setup copy in one pass.
- No changes to provider setup surfaces outside the current Control UI ask.

## User Experience

### Shared Pattern

For any setup-blocked item:

- Show the existing blocked state label.
- Show one inline `Setup` row directly in the card or item surface.
- If a copyable command or snippet exists, show `Copy`.
- If extra details or docs exist, show `More`.
- Keep extra details hidden by default.

### Simple Setup

Examples:

- `OPENAI_API_KEY=...`
- `DISCORD_BOT_TOKEN=...`
- `brew install signal-cli`

Default state:

- one setup line
- optional `Copy`
- no expanded detail block

### Complex Setup

Examples:

- install plus follow-up environment assumptions
- binary installation plus optional custom path handling
- multi-step local prerequisites

Default state:

- one setup line
- `Copy`
- `More`

Expanded state:

- reveal secondary detail lines
- reveal docs path or docs link if present
- keep the first setup line unchanged so the primary action remains stable

## Placement

### Skills

Render setup guidance in:

- skill list rows for blocked skills
- skill detail dialog

The `Needs Setup` filter remains a navigation/filter affordance only. It does not become a separate setup workflow.

### Channels

Render setup guidance inline in existing channel cards.

Do not add a new top-level setup panel. Guidance belongs in the channel card the user is already looking at.

## Data Contract

Use one small additive shape for both skills and channels:

```ts
type SetupGuidance = {
  summary: string;
  copyText?: string;
  details?: string[];
  docsPath?: string;
};
```

Rules:

- `summary` is always present when setup guidance exists.
- `copyText` is the exact payload copied to clipboard.
- `details` contains optional expanded lines.
- `docsPath` is fallback/supporting guidance, not the primary copied action.

## Skills Source Of Truth

Add optional `setupGuidance` to `SkillStatusEntry` in `src/agents/skills-status.ts`.

Build it centrally from existing skill status metadata:

- `install`
- `missing`
- `primaryEnv`
- config checks

Priority for skill `copyText`:

1. installer command/snippet derived from the preferred install option
2. env snippet derived from `primaryEnv`
3. config-path hint when no better command/snippet exists

The UI must not derive commands from labels like `Install ...`. The status layer should provide the explicit copy payload.

## Channels Source Of Truth

Add optional `setupGuidance` to `ChannelSetupStatus` in `src/channels/plugins/setup-wizard-types.ts`.

Thread it through the existing setup-wizard adapter path in `src/channels/plugins/setup-wizard.ts`.

Expose it through the gateway `channels.status` payload via:

- `src/gateway/server-methods/channels.ts`
- `src/gateway/protocol/schema/channels.ts`

This keeps setup truth in channel-owned setup surfaces rather than in UI heuristics.

## Channel Adoption Strategy

Do not require every channel to define guidance immediately.

Initial explicit guidance should target channels whose current hints are not copyable enough, including:

- Discord
- Slack
- Signal
- Telegram

All other channels should continue to work through fallback rendering until they opt into richer guidance.

This avoids a large all-channel migration while still delivering meaningful improvement quickly.

## Rendering Rules

Use one shared Control UI renderer for setup guidance and reuse it in both skill and channel views.

Rendering behavior:

- if `copyText` exists, show `Copy`
- if `details` or `docsPath` exist, show `More`
- if neither exists, render only the `summary`
- keep details collapsed by default
- show expanded details only after explicit user action

The default collapsed state should remain visually compact enough for dense Control UI lists.

## Fallback Behavior

If setup guidance is absent:

- preserve current status-only rendering
- preserve current config editing controls
- preserve current probe and refresh controls

For channels specifically:

- current hint/status lines remain valid fallback behavior
- docs links remain secondary guidance when richer setup metadata is missing

## Testing

### Skills

Add or update unit coverage in `src/agents/skills-status.test.ts` for:

- installer-backed guidance
- env-backed guidance
- config-path fallback guidance

### Channels

Add or update setup-wizard tests for:

- optional `setupGuidance` propagation through `ChannelSetupStatus`
- channels without guidance continuing to behave unchanged

### Gateway

Update `src/gateway/server-methods/channels.status.test.ts` for additive payload coverage.

### Control UI

Add or update view tests to verify:

- simple setup renders one line plus copy
- complex setup renders collapsed by default
- details render only after expansion
- fallback rendering works when guidance is absent

## Documentation

Update `docs/web/control-ui.md` to describe the user-visible setup guidance behavior in `Skills` and `Channels`.

Documentation should describe:

- inline setup row
- copy-first behavior
- expandable details for complex setup

Documentation should not expose internal field names unless required by a public protocol reference.

## Risks And Constraints

- Channel setup copy can drift if plugin owners do not keep guidance aligned with onboarding changes.
- Skills guidance can become misleading if the copied command is inferred loosely instead of emitted explicitly.
- The collapsed state must stay visually restrained or it will add noise to already-dense Control UI cards.

These are controlled by keeping copy generation close to existing setup/status owners and by reusing one shared renderer.

## Implementation Boundary

This design intentionally stops at:

- additive status contract changes
- shared inline rendering
- targeted channel adoption
- tests and docs updates

It does not include:

- implementation of new onboarding flows
- repo-wide setup text cleanup
- broader config or auth UX redesign
