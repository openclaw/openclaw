# Validation — Agent Skills format interop

## Automated tests

- `src/plugins/skill-manifest.test.ts` — parse canonical + legacy frontmatter; reject ambiguous mixes.
- `src/plugins/discovery.test.ts` — both shapes discovered identically.
- `src/plugins/skills-import.test.ts` — import accepts an Anthropic-shape tarball; rejects unauthorized executable scripts.
- `src/plugins/skills-export.test.ts` — export round-trips through import without manifest loss.
- `src/agents/tool-policy-skills.test.ts` — `allowed_tools` on a skill restricts the agent's tool surface during that skill's execution.
- E2E: `scripts/e2e/skills-interop-docker.sh` — import a canonical-shape skill; run a session that triggers it; assert the agent uses only the allowed tools.

## Smoke checks

- `openclaw skills import <fixture-tarball>` succeeds and the skill appears in `openclaw skills list`.
- `openclaw skills export github` produces a tarball; `tar -tf` shows SKILL.md at the root.
- `openclaw doctor` lists any skills still on the legacy shape.

## Manual criteria

- The exported tarball loads cleanly into Claude Code (`/skills add ./openclaw-github.tar.gz`).
- Migration hint copy in doctor output is actionable.

## AI eval plan

- Success criteria: on a 10-prompt skill-routing eval, the agent picks the right skill ≥ 90% of the time after import; ≤ 5% misfire on prompts that should not trigger a skill.
- Eval dataset: `tests/evals/skills-routing/` — operator prompts × expected skill selection.
- Regression set: 5 cases — explicit skill mention, implicit match, ambiguous, no-match, denied-by-allowed-tools.
- Cadence: per-PR on fixtures; nightly on the live-models matrix.

## Risks & rollback

- **Risks:**
  - Misparsed frontmatter silently drops a skill on startup. *Detect via* explicit parser tests + a startup log line per discovered skill (count + names).
  - Malicious imported skill ships scripts. *Mitigate* by requiring `--allow-scripts` and printing the script paths before extraction.
- **Rollback:** revert the PR; the legacy shape still loads via the same parser.

## Open questions

- Do we publish the canonical openclaw skills (canvas, clawhub, peekaboo, etc.) into Anthropic's Agent Skills registry by default, or operator-opt-in? Defer to a follow-up.
