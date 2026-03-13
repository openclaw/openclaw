## Remaining opportunities (all low priority / no primary metric impact)

Per-conversation stable_chars is at **30,735/30,933 = 99.4% = theoretical maximum**.
The remaining 0.6% (198 chars) is the GroupChat content itself — irreducible by definition.
No further primary metric improvement is possible without changing the benchmark scenario.

### If a new optimization target is needed

Switch to a scenario where there is still headroom:

| Scenario     | Current | Theoretical Max | Gap   |
| ------------ | ------- | --------------- | ----- |
| toolNames    | ~95.1%  | ~96.5%          | ~1.4% |
| deployConfig | ~95.4%  | ~97%            | ~1.6% |
| modelAliases | ~97.4%  | ~98%            | ~0.6% |

These gaps exist due to the frequency-based ordering trade-offs (each section being before
GroupChat means GroupChat header is non-stable for those scenarios). Tiny and not worth pursuing.

### hasGateway conditional (~300 chars, STABLE BOILERPLATE)

`## OpenClaw Self-Update` appears/disappears based on `hasGateway`. Only matters if gateway
is ever added to a deployment that didn't have it (essentially never in production).
Fix: unconditional section. Impact: zero on any current benchmark (gateway always present).

### Architecture (requires product decision)

- Separate AGENTS.md into stable base + project overlay: would push workspace file boundary
  further (already at theoretical max for per-conv, so marginal gain).
- Build-time: mtime-gated file cache, skills hash-gated regeneration. Zero metric impact.
