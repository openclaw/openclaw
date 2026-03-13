## Remaining opportunities (low priority)

All major cache invalidation scenarios have been addressed. The remaining ideas are
architecture-level improvements or very rare events.

### Per-scenario ordering trade-offs

The dynamic tail is ordered by frequency (most stable FIRST, most volatile LAST).
This is the OPTIMAL combined ordering for expected KV cache savings across all events.

For any individual scenario, the "perfect" ordering would put that scenario's section LAST
(to maximise its stable prefix). But this conflicts with other scenarios. The frequency-based
ordering is the Pareto-optimal trade-off:

- toolNames (plugin install, rare): 96.2% stable — theoretical max for this ordering
- deployConfig (yearly): 90.7% stable
- modelAliases (quarterly): ~97% stable
- skills (monthly): 99.6% stable
- workspaceNotes (weekly): 100.0% stable
- MEMORY.md (daily): 99.5% stable

**Combined weighted expected savings** with this ordering vastly exceeds any single-scenario-
optimised ordering. Do NOT change the tail ordering without considering the full impact.

### toolNames scenario: 96.2% vs theoretical ~100%

The 3.8% gap (1,138 chars) is `modelAliases + skills + workspaceNotes` that appear AFTER
the tool manifest and become non-stable when plugin tools are added. These sections MUST be
after tool manifest in the frequency-based ordering. Accept this gap.

If plugin installs become a much more common event (e.g., auto-installed plugins), revisit.

### ## Tooling section hasGateway conditional (~480 chars)

When `gateway` tool is added/removed, the `## OpenClaw Self-Update` section (~480) appears
or disappears, causing a diff at that position. This is in the STABLE BOILERPLATE.

Fix: make `## OpenClaw Self-Update` section unconditional (always show if sections_spawn/gateway
exists), or move to dynamic tail. Very low priority: `gateway` is always present in production
deployments.

### Build-time improvements (no primary metric impact)

- Cross-session mtime-gated bootstrap cache: track file mtimes between sessions, only re-read
  files that actually changed. Reduces build time.

- Skills hash-gated regeneration: cache the skills prompt by content hash of all SKILL.md files;
  only regenerate when a skill file changes. Build time improvement.

### Architecture ideas

- Separate AGENTS.md into base (stable global protocol) + project overlay (frequent per-project
  notes). User-facing design change. Would push AGENTS.md base into stable prefix, improving
  the per-conversation boundary from ~28k to ~28k + AGENTS.md_base_size.

- Combined benchmark: a single benchmark that measures weighted expected cache savings across
  ALL scenarios simultaneously, rather than one scenario at a time. This would allow autoresearch
  to directly optimise the combined objective.
