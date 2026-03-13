## Remaining opportunities (very low priority)

All major cache invalidation scenarios have been addressed. Per-conversation is at 99.4%
(theoretical maximum — the remaining 0.6% is the GroupChat content itself, which changes
by definition). Other scenarios are at 95-99.6%.

### Final scenario summary

- per-conversation: 99.4% (30,735/30,933) — THEORETICAL MAX (limited by GroupChat content)
- MEMORY.md daily: ~99.5%
- workspaceNotes (weekly): ~99.6%
- skills (monthly): ~99.5%
- modelAliases (quarterly): ~97.4%
- toolNames (plugin install, rare): ~95.1%
- deployConfig (yearly): ~95.4%

### ## Tooling section hasGateway conditional (~300 chars)

When `gateway` tool is added/removed, the `## OpenClaw Self-Update` section (~300 chars)
appears or disappears, causing a diff at position ~3,600 in the stable boilerplate.

Fix: make `## OpenClaw Self-Update` section unconditional (always show), or move to
dynamic tail. Very low priority: `gateway` is always present in production deployments.
Adding this would recover ~300 chars in the stable boilerplate for the "add gateway"
scenario (essentially never happens in production).

### Build-time improvements (no primary metric impact)

- Cross-session mtime-gated bootstrap cache: track file mtimes between sessions, only re-read
  files that actually changed. Reduces build time.

- Skills hash-gated regeneration: cache the skills prompt by content hash of all SKILL.md files;
  only regenerate when a skill file changes. Build time improvement.

### Architecture ideas

- Separate AGENTS.md into base (stable global protocol) + project overlay (frequent per-project
  notes). User-facing design change. Would push AGENTS.md base into stable prefix, improving
  the per-conversation boundary further (already at 99.4% so marginal gain).

- Combined benchmark: a single benchmark that measures weighted expected cache savings across
  ALL scenarios simultaneously. Useful for auditing but doesn't reveal new improvements at
  current convergence level.

### toolNames vs deployConfig ordering trade-off

Current: TM → deployConfig → modelAliases → ... → MEMORY.md → GroupChat

- toolNames: ~95.1% (loses ~1.9% because deployConfig comes after TM, adding non-stable content
  for toolNames scenario when deployConfig is stable in toolNames v1/v2)
- deployConfig: ~95.4% (benefits from TM being in stable prefix for deployConfig scenario)

If toolNames installs become much more frequent (e.g., auto-installed plugins), consider
swapping deployConfig back before TM. Currently: deployConfig yearly vs toolNames monthly at most.
