# Windows via WSL2 Completeness

Use this rubric when assigning category Completeness scores for the
`windows-via-wsl2` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Windows via WSL2` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- WSL Setup and Updates: WSL2 + Ubuntu installation, Node runtime, Linux install flow inside WSL2, WSL2 runtime boundary, WSL2 network-family requirements, Source install and build inside WSL2, openclaw update, npm/pnpm/git package-root, Managed systemd Gateway restart, Service metadata refresh, Package-manager caveats
- Gateway Service Lifecycle: Onboarded systemd install, Gateway service install, systemd user unit rendering, WSL-aware systemd unavailable hints, Doctor service repair, WSL user-service linger, Systemd availability after Windows boot, Windows startup task for WSL, Verification before Windows sign-in, Clear expectations around PC power
- Gateway Access and Exposure: Gateway token/password auth, Provider credentials, Gateway auth SecretRefs, Remote URL credential precedence, WSL virtual network, Windows portproxy setup, Windows Firewall rules, Reachable Gateway URLs, Loopback and LAN exposure, WSL2 IPv4 networking, Tailscale remote access
- Diagnostics and Repair: openclaw doctor, openclaw status, openclaw logs, SecretRef, WSL/systemd unavailable hints, Operator repair guidance after WSL2 service
- Browser and Control UI: WSL2 Gateway with Windows browser, Windows Control UI URL, Raw remote CDP to Windows Chrome, Host-local Chrome MCP, Browser profile cdpUrl, Layered diagnostics

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
