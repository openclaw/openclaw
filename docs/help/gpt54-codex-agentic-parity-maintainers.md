# GPT-5.4 / Codex parity maintainer notes

This note is the review-oriented companion to `gpt54-codex-agentic-parity.md`.

The earlier follow-up wave became hard to review because the remaining work was split across too many proof slices. The closeout is now intentionally collapsed into **2 PRs**:

- **Runtime Completion Rollup**
- **Parity Proof Rollup**

The already-merged foundation stays the same:

- PR A: strict-agentic execution contract
- PR B: runtime truthfulness
- PR C: execution correctness and replay/liveness surfacing
- PR D: first-wave parity harness

## Merge units

### Runtime Completion Rollup

Owns:

- default strict-agentic activation for GPT-5-family `openai` / `openai-codex` runs
- shared GPT-5-family matcher for activation and retry enforcement
- explicit blocked-exit replay/liveness metadata
- any minimal runtime follow-up required by the new instruction-followthrough proof

Does not own:

- parity report formatting
- mock-provider routing
- summary artifact provenance
- docs/runbook

### Parity Proof Rollup

Owns:

- expanded parity pack
- required-scenario gate semantics
- scenario-specific tool-call enforcement
- Anthropic mock baseline support
- offline mock auth staging
- `qa-suite-summary.json` `run` provenance
- parity workflow / runbook
- the new `instruction-followthrough-repo-contract` scenario

Does not own:

- provider/runtime auth truthfulness
- tool-schema normalization
- the original strict-agentic runtime contract itself

## Mapping back to the original prompt

| Original concern from the GPT-5.4 prompt | Owning merge unit |
| --- | --- |
| “It stops after planning” | PR A foundation + Runtime Completion Rollup |
| “It seeks permission every turn” | PR B foundation + Runtime Completion Rollup |
| “Tool usage feels confused / not agentic enough” | PR C foundation + Parity Proof Rollup |
| “`/elevated full` needs to be truthful” | PR B foundation |
| “Replay / continuation issues should stay visible” | PR C foundation + Runtime Completion Rollup |
| “We need proof against Opus, not vibes” | PR D foundation + Parity Proof Rollup |
| “It reads AGENT.md / SOUL.md but doesn’t really follow them” | Parity Proof Rollup via `instruction-followthrough-repo-contract` |

## Review checklist

### Runtime Completion Rollup

Look for:

- unconfigured GPT-5-family runs auto-activating strict-agentic
- explicit `executionContract: "default"` still opting out
- blocked exits surfacing `replayInvalid`, `livenessState: "blocked"`, and terminal lifecycle metadata
- no new public runtime API

Expected evidence:

- `src/agents/execution-contract.test.ts`
- `src/agents/pi-embedded-runner/run.incomplete-turn.test.ts`

### Parity Proof Rollup

Look for:

- the pack contains the full 11 scenarios
- tool-mediated scenarios require real tool evidence
- Anthropic `/v1/messages` mock requests exercise the same scenario dispatcher
- `qa-suite-summary.json` is self-describing
- docs and workflow describe mock structural gate vs live proof accurately

Expected evidence:

- `extensions/qa-lab/src/agentic-parity-report.test.ts`
- `extensions/qa-lab/src/scenario-catalog.test.ts`
- `extensions/qa-lab/src/mock-openai-server.test.ts`
- `extensions/qa-lab/src/qa-gateway-config.test.ts`
- `extensions/qa-lab/src/suite.summary-json.test.ts`
- `.github/workflows/parity-gate.yml`

## Release gate

Do not call the project complete until all of these are true:

- A/B/C/D remain merged and stable
- both rollup PRs are merged
- GPT-5.4 no longer stalls after planning on the default supported lane
- GPT-5.4 no longer fakes tool progress
- GPT-5.4 no longer gives false `/elevated full` guidance
- replay/liveness failures are explicit
- `instruction-followthrough-repo-contract` passes
- the merged-main parity report shows GPT-5.4 matches or beats Opus 4.6 on the agreed metrics

## Mock gate vs live proof

Keep this distinction explicit in review:

- the workflow is the **mock structural gate**
- the final product claim still depends on the **live-frontier proof**

The mock gate is necessary because it keeps the harness reproducible and catches regressions in scenario registration, tool-call assertions, and artifact wiring. It is not enough by itself for the release claim.
