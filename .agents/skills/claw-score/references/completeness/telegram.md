# Telegram Completeness

Use this rubric when assigning category Completeness scores for the
`telegram` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Telegram` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Channel Setup and Operations: BotFather token creation, TELEGRAM_BOT_TOKEN, Setup wizard credential capture, Startup getMe, Doctor/status surfacing, Named account configuration, CLI/message-tool targets, Directory adapters, Channel status, Account-scoped outbound, Long polling runner startup, Webhook listener startup, Reconnect, Restart, Named account configuration, Directory adapters and configured peers/groups for, Channel status, Account-scoped outbound, Long polling runner startup, Reconnect, Restart
- Access and Identity: dmPolicy modes, Pairing-code approval, Numeric Telegram user ID normalization with telegram, allowFrom, Unauthorized DM, Group allowlists, Supergroup negative chat IDs, Forum topic session keys, ACP topic routing, Session key construction
- Conversation Routing and Delivery: dmPolicy modes, Pairing-code approval, Numeric Telegram user ID normalization with telegram, allowFrom, Unauthorized DM, Group allowlists, Supergroup negative chat IDs, Forum topic session keys, ACP topic routing, Session key construction, Inbound media download, Voice notes, Location, Poll sending, Reactions, Text, Preview streaming, Reply threading tags, Durable outbound message recording, Voice notes, Poll sending, Reply threading tags, Durable outbound message recording
- Media and Rich Content: Inbound media download, Voice notes, Location, Poll sending, Reactions, Text, Preview streaming, Reply threading tags, Durable outbound message recording, Voice notes, Poll sending, Reply threading tags, Durable outbound message recording, Inbound media download, Voice notes, Location and venue extraction into channel context, Poll sending, Reactions
- Native Controls and Approvals: Inline keyboard rendering, Exec approvals in DMs, Message actions, Action capability discovery, Native setMyCommands startup sync, Command name/description normalization, Built-in commands, Command authorization in DMs, Model buttons, Native `setMyCommands` startup sync, Command name/description normalization, Built-in commands such as `/help`, Command authorization in DMs, Model buttons and command UI helpers

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
