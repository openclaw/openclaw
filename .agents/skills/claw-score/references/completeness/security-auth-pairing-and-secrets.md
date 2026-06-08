# Security, auth, pairing, and secrets Completeness

Use this rubric when assigning category Completeness scores for the
`security-auth-pairing-and-secrets` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Security, auth, pairing, and secrets` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Approval Policy and Tool Safeguards: Approval Policy, Dangerous Tool Safeguards
- Gateway Auth and Remote Access: Shared Gateway token/password auth, Gateway auth mode, Trusted-proxy identity, Tailscale Serve/Funnel, Bind and origin restrictions, WebSocket handshake auth, Operator-facing docs, Browser Control UI, Remote Client Trust
- Channel Access Control: Channel Identity, Allowlists, Sender Pairing
- Device and Node Pairing: Setup codes, Device identity creation, Device-token issuance, Device pairing approvals for operator, Operator scopes that gate pairing, Local Control UI, Auth migration, Operator-facing docs, Node Pairing, Capability Trust, Remote Exec Approvals
- Plugin Trust: Plugin Installation Trust, Security Boundaries
- Credential and Secret Hygiene: Provider Auth Profiles, API Key Health, Secrets Storage, Redaction, Configuration Hygiene

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
