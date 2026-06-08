# Matrix Completeness

Use this rubric when assigning category Completeness scores for the
`matrix` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Matrix` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Channel Setup and Operations: Matrix plugin identity, Setup wizard, Account discovery, Matrix doctor warnings, Matrix probe/status, Shared Matrix client resolution, Monitor startup, Startup maintenance, Matrix doctor warnings, Matrix probe/status, Monitor startup, Startup maintenance
- Access and Identity: DM policy, Direct-room classification, Inbound route selection across sender-bound DMs, Mention gates, Matrix thread reply routing, Persisted Matrix thread routing managers, ACP/subagent spawn hooks
- Conversation Routing and Delivery: DM policy, Direct-room classification, Inbound route selection across sender-bound DMs, Mention gates, Matrix thread reply routing, Persisted Matrix thread routing managers, ACP/subagent spawn hooks, Channel action discovery, Message send/read/edit/delete, Profile media loading, Outbound Matrix text, Message presentation metadata, Inbound media failure handling, Message send/read/edit/delete, Profile media loading, Outbound Matrix text, Message presentation metadata, Inbound media failure handling
- Media and Rich Content: Channel action discovery, Message send/read/edit/delete, Profile media loading, Outbound Matrix text, Message presentation metadata, Inbound media failure handling
- Native Controls and Approvals: Channel action discovery, Message send/read/edit/delete, Profile media loading, Outbound Matrix text, Message presentation metadata, Inbound media failure handling, Matrix native exec, Origin target resolution from Matrix turn, Approver DM target resolution, Matrix approval metadata, Origin target resolution from Matrix turn, Approver DM target resolution, Matrix approval metadata
- Encryption and Verification: Encryption setup, Encrypted media upload/download, Legacy state

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
