# Gateway Web App Completeness

Use this rubric when assigning category Completeness scores for the
`browser-control-ui-and-webchat` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Gateway Web App` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

## Scoring Questions

For each category, ask:

- Can the intended user or operator complete the category workflow end to end?
- Are the taxonomy features present as supported capabilities rather than isolated implementation fragments?
- Are the important lifecycle stages represented: setup, normal operation, status/inspection, recovery, and upgrade or removal where relevant?
- Are the important environment, provider, platform, channel, or security branches present for this surface?
- Do the known gaps leave major user-visible capability branches missing?

## Surface-Specific Guidance

- Favor higher Completeness when the category supports the full operator-visible workflow described by taxonomy and the category note evidence.
- Lower Completeness when only the happy path exists, when important variants are undocumented or unimplemented, or when recovery/status paths are missing.
- Do not lower Completeness because tests are thin; that is Coverage.
- Do not lower Completeness because implementation quality is fragile; that is Quality.

## Category Scope

- Browser Realtime Talk: Browser Talk start/stop, Provider session selection, Gateway relay audio, Tool-call consults, Steer and cancel
- Browser Access and Trust: Device pairing, Token/password auth, Tailscale Serve auth, Trusted proxy auth, Allowed origins/gatewayUrl
- Configuration: Config snapshots, Schema form editing, Raw JSON editing, Base-hash guarded writes, Apply and restart
- Browser UI: Gateway-hosted UI, Dashboard open/auth bootstrap, Base-path routing, Static asset recovery, Dev gatewayUrl target, PWA install metadata, Service worker updates, VAPID keys, Subscribe/unsubscribe, Test notifications
- WebChat Conversations: Send and abort, Session and agent picker, Model/thinking controls, Attachments, Markdown/tool/media rendering, chat.history projection, chat.send lifecycle, Abort/partial retention, Injected assistant notes, Reconnect continuity, Hosted embeds, External embed gating, Assistant media tickets, Authenticated avatars, CSP image policy
- Remote WebChat: macOS WebChat transport, SSH tunnel data plane, Direct ws/wss remote mode, Session continuity, Remote troubleshooting
- Operator Console: Health/status/models, Live log tail, Update run/status, Activity summaries, RPC timing telemetry, Channels/login, Session manager and history, Cron, Skills/nodes, Exec approvals/agents

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
