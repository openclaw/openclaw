# macOS Gateway host Completeness

Use this rubric when assigning category Completeness scores for the
`macos-gateway-host` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `macOS Gateway host` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- CLI Setup: Hosted installer, Node 24 recommendation, App-triggered CLI install, Shell PATH and version-manager drift
- Local Gateway Integration: App local/remote connection mode, App-managed Gateway LaunchAgent install/restart/uninstall, CLI install detection, Attach-to-existing local Gateway compatibility, Gateway endpoint, gateway.mode=local configuration, Loopback bind, Local app endpoint resolution, Bonjour discovery
- Remote Gateway Mode: macOS app "Remote over SSH", SSH tunnel setup, Tailscale MagicDNS, Remote endpoint token/password/TLS fingerprint, Local node host startup
- Gateway Service Lifecycle: Per-user Gateway LaunchAgent install, launchctl bootstrap, LaunchAgent labels, Gateway token/env handling, App-managed LaunchAgent handoff, openclaw update package/git handoff, Managed service refresh, Stale updater launchd job detection, openclaw uninstall, Stranded service recovery
- Diagnostics and Observability: LaunchAgent log paths, openclaw gateway status --deep, Gateway silently stops responding, Stale updater jobs
- Permissions and Native Capabilities: macOS TCC permission prompts/status, Native node capability exposure, system.run policy, Permission-driven support
- Profiles and Isolation: Profile-specific LaunchAgent labels, Profile-specific state/config/workspace roots, Derived ports, Rescue bot setup, Extra Gateway process detection

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
