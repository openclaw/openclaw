# iMessage / BlueBubbles Completeness

Use this rubric when assigning category Completeness scores for the
`imessage-bluebubbles` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `iMessage / BlueBubbles` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Channel Setup and Operations: Translate legacy config, Cut over safely, Handle migration caveats, Run local imsg, Run through SSH wrapper, Grant macOS permissions, Probe runtime health, Account setup prompts, Account status checks, Doctor repair checks, Account Config, Translate legacy config, Cut over safely, Handle migration caveats, Run local imsg, Run through SSH wrapper, Grant macOS permissions, Probe runtime health
- Access and Identity: Authorize direct senders, Route direct conversations, Bind ACP sessions, Group Policy, Mentions, System Prompts, Group Policy, Mentions, System Prompts
- Conversation Routing and Delivery: Watch live messages, Coalesce split-send DMs, Replay missed messages, Seed conversation history, Authorize direct senders, Route direct conversations, Bind ACP sessions, Group Policy, Mentions, System Prompts
- Media and Rich Content: Media, Attachments, Remote Fetch, Chunking, Native Actions, Private API, Message Tool
- Native Controls and Approvals: Native Approvals, Reactions, Operator Control, Media, Attachments, Remote Fetch, Chunking, Native Actions, Private API, Message Tool, Native Actions, Private API, Message Tool

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
