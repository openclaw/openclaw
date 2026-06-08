# Native Windows CLI and Gateway Completeness

Use this rubric when assigning category Completeness scores for the
`native-windows-cli-and-gateway` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Native Windows CLI and Gateway` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Setup: PowerShell installer, Node and package-manager bootstrap, npm global install, Packaged CLI launcher, Windows command shims, openclaw onboard, Local Gateway config, Daemon install flags, Native-vs-WSL setup boundary
- Gateway Management: openclaw gateway, Foreground runtime health/readiness, Windows-specific restart/signal, Unmanaged foreground mode, openclaw gateway install, Gateway launcher files, Scheduled Task runtime status, Startup-folder fallback, openclaw status, Windows service inspection, Post-install diagnostics
- Networking: Native Windows host binding, netsh interface portproxy, Gateway status and probe output, Loopback, LAN, and WSL boundary
- Updates: openclaw update on native Windows package, Managed Gateway stop/restart, Detached update handoff, Windows package locks

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
