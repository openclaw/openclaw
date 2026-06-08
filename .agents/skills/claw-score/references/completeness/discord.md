# Discord Completeness

Use this rubric when assigning category Completeness scores for the
`discord` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Discord` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Channel Setup and Operations: Application and bot setup, Token and application ID configuration, Setup wizard and account inspection, Status, doctor, and intent checks, Multi-account bot configuration, Account monitor startup, Gateway WebSocket lifecycle, Reconnect and heartbeat handling, Rate limits and gateway metadata, Status, probe, and health-monitor recovery
- Access and Identity: DM policy modes, Allowlist inheritance, Pairing-code approval, Sender authorization, Access-group authorization, Group DM authorization
- Conversation Routing and Delivery: Guild and channel admission, Mention gating, Session key isolation, Configured and runtime routing, Inbound context visibility, Forum and media-channel thread posts, Thread actions, Target parsing, Thread context resolution, Thread-bound session routing, ACP agent routing, Routing lifecycle, Discord forum/media channel posts created as, CLI and message-tool thread actions, Discord target parsing for `channel:<id>`, Thread context resolution, Thread-bound session routing for `/focus`, `/unfocus`, `/agents`, `/session idle`, `/session max-age`, `sessions_spawn({ thread, ACP current-conversation bindings and ACP thread, Binding lifecycle behavior, Direct and thread sends, Text chunking and reply mode, Draft and progress edits, Mention and embed rendering, REST retry and final delivery, File uploads, Component file and media-gallery blocks, Video caption follow-up, Voice-message upload, Inbound attachment context
- Media and Rich Content: Direct and thread sends, Text chunking and reply mode, Draft and progress edits, Mention and embed rendering, REST retry and final delivery, File uploads, Component file and media-gallery blocks, Video caption follow-up, Voice-message upload, Inbound attachment context, Direct and thread sends, Text chunking and reply mode, Draft and progress edits, Mention and embed rendering, REST retry and final delivery, File uploads, Component file and media-gallery blocks, Video caption follow-up, Voice-message upload, Inbound attachment context, Outbound file uploads from URLs and, Component v2 file and media-gallery blocks, Video caption handling and follow-up media-only delivery, Discord voice-message sends with OGG/Opus conversion, Inbound media/attachment-aware debounce behavior, Realtime voice-channel conversations, General text-only delivery
- Native Controls and Approvals: Native slash command registration, Native slash command execution, Model Picker Commands, Components v2 messages, Callback TTL, Native Discord exec/plugin approvals, Sensitive owner-only command routing for prompts, Discord message actions, Action gates under channels.discord.actions.*
- Realtime Voice and Calls: Voice Channel Lifecycle, Auto-join and follow-users, Realtime voice modes, Wake, barge-in, and echo handling, Voice codec and DAVE recovery

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
