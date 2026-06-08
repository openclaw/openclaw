# Google Chat Completeness

Use this rubric when assigning category Completeness scores for the
`google-chat` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Google Chat` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Channel Setup and Operations: Google Cloud project setup, Chat app configuration, Service account setup, Webhook audience and path, Workspace visibility and app status, Guided channel setup, Account resolution, Service account SecretRefs, Env file and inline credentials, Channel status and probes, Directory and mutable-id diagnostics, NPM and ClawHub install, Plugin docs and catalog routing, Channel aliases and labels, Operator status UI, Install/update metadata, Webhook path handling, Standard Chat token verification, Workspace add-on token verification, Audience and appPrincipal validation, Shared-path target selection, Auth rejection diagnostics, Account resolution, Service account SecretRefs, Env file and inline credentials, Channel status and probes, Directory and mutable-id diagnostics, NPM and ClawHub install, Plugin docs and catalog routing, Channel aliases and labels, Operator status UI, Install/update metadata, Webhook path handling, Standard Chat token verification, Workspace add-on token verification, Audience and appPrincipal binding, Shared-path target selection, Auth rejection diagnostics
- Access and Identity: DM pairing approval, Sender allowlists, Google Chat identity matching, Direct session routing, Pairing diagnostics, Space allowlists, Mention gating, Sender access groups, Group session isolation, Bot-loop protection, Space diagnostics
- Conversation Routing and Delivery: DM pairing approval, Sender allowlists, Google Chat identity matching, Direct session routing, Pairing diagnostics, Space allowlists, Mention gating, Sender access groups, Group session isolation, Bot-loop protection, Space diagnostics, Inbound attachments, Outbound media replies, Message upload action, Media source and size controls, Media receipts and thread placement, Text send action, Upload-file action, Reaction actions, Action capability gates, Approval sender matching, Thread-aware replies, Streaming and chunked replies, Typing placeholder lifecycle, Message-tool current-source replies, NO_REPLY cleanup, Markdown/text rendering, Thread-aware replies, Streaming and chunked replies, Typing placeholder lifecycle, Message-tool current-source replies, NO_REPLY cleanup, Markdown/text rendering
- Media and Rich Content: Inbound attachments, Outbound media replies, Message upload action, Media source and size controls, Media receipts and thread placement, Text send action, Upload-file action, Reaction actions, Action capability gates, Approval sender matching, Thread-aware replies, Streaming and chunked replies, Typing placeholder lifecycle, Message-tool current-source replies, NO_REPLY cleanup, Markdown/text rendering
- Native Controls and Approvals: Inbound attachments, Outbound media replies, Message upload action, Media source and size controls, Media receipts and thread placement, Text send action, Upload-file action, Reaction actions, Action capability gates, Approval sender matching, Thread-aware replies, Streaming and chunked replies, Typing placeholder lifecycle, Message-tool current-source replies, NO_REPLY cleanup, Markdown/text rendering

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
