# Microsoft Teams Completeness

Use this rubric when assigning category Completeness scores for the
`microsoft-teams` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Microsoft Teams` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Channel Setup and Operations: Teams CLI app creation, Bot registration and manifest upload, Credential configuration, Teams app install verification, Setup status, Probe and scope reporting, Teams app doctor, Webhook and health diagnostics, Operator repair paths, Text formatting and chunking, Adaptive and presentation cards, Progress streaming, Delivery receipts and errors, Queued and proactive replies, Webhook Runtime, SDK Lifecycle, Proactive Cloud Boundary, Setup status, Probe and scope reporting, Teams app doctor, Webhook and health diagnostics, Operator repair paths, Webhook Runtime, SDK Lifecycle, Proactive Cloud Boundary
- Access and Identity: DM pairing, Stable sender identity, Allowlists and access groups, Invoke and command authorization, Teams-originated config writes, Bot Framework SSO invokes, Delegated token storage, Graph directory lookup, Member profile lookup, Bot Framework SSO invokes, Delegated token storage, Graph directory lookup, Member profile lookup
- Conversation Routing and Delivery: Team and channel allowlists, Deterministic channel replies, Mention-gated group access, Session routing, Reply and thread context, Text formatting and chunking, Adaptive and presentation cards, Progress streaming, Delivery receipts and errors, Queued and proactive replies, Webhook Runtime, SDK Lifecycle, Proactive Cloud Boundary, Text formatting and chunking, Adaptive and presentation cards, Progress streaming, Delivery receipts and errors, Queued and proactive replies, Webhook Runtime, SDK Lifecycle, Proactive Cloud Boundary
- Media and Rich Content: Inbound attachments, Graph-hosted media, File consent, SharePoint and OneDrive sharing, Media fetch safety
- Native Controls and Approvals: Message action discovery, Polls and reactions, Read, edit, delete, and pin, Native approval cards, Feedback and group actions

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
