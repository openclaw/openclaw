# Native Windows companion app Completeness

Use this rubric when assigning category Completeness scores for the
`native-windows-companion-app` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Native Windows companion app` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Installation and Updates: Official app download, MSI/MSIX/App Installer/winget-style packaging, Windows architecture handling for x64, App release channel
- Gateway Connection: App-managed local Gateway attach/start, Remote Gateway connection modes, Device/node pairing
- Chat Sessions: Native Windows chat window, Gateway chat transport
- Status and Repair: App health states, App-specific repair, Windows system tray app, Status indicators, App-specific notification permission
- Desktop Tools and Permissions: Windows node identity, Host command execution, Desktop command policy, App approval prompts, Screen and media capture, Canvas host behavior, Windows shell integrations, App secrets, Windows ACL, Command approval

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
