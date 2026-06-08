# Channel framework Completeness

Use this rubric when assigning category Completeness scores for the
`channel-framework` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Channel framework` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Channel Actions Commands and Approvals: Channel-native commands, Native command session target, Message actions, Message tool API discovery, Channel-native approval prompts
- Channel Setup: Supported channel catalog, Channel status taxonomy in channels list, Setup/onboarding flows, Install-on-demand, Setup wizard metadata
- Group Thread and Ambient Room Behavior: Group/channel session isolation, Mention-required, Native threads, Broadcast groups, Bot-loop protection
- Inbound Access and Identity Gates: DM pairing, Group/channel allowlists, Access group expansion, Mention gating, Sanitized inbound identity/route projections
- Media Attachments and Rich Channel Data: Inbound media normalization, Outbound direct text/media sends, Provider-specific channelData, Media roots
- Outbound Delivery and Reply Pipeline: Automatic final reply delivery, Durable outbound send orchestration, Reply pipeline transforms, Provider outbound adapter bridge
- Conversation Routing and Delivery: Inbound conversation routing, Session key construction, Agent binding precedence, Runtime conversation bindings, Thread/parent-child placement, Plugin registry resolution, Channel account startup, Whole-channel lifecycle controls, Config/secrets reload interactions, Auto-restart
- Status Health and Operator Controls: channels.status, Channel health policy, Operator CLI controls, Status read-model

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
