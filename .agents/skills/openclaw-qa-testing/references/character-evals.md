## Character evals

Use `qa character-eval` for style/persona/vibe checks across multiple live models.

```bash
pnpm openclaw qa character-eval \
  --output-dir .artifacts/qa-e2e/character-eval-<tag>
```

- Runs local QA gateway child processes, not Docker.
- Packaged `pnpm build` omits QA Lab + qa-channel by design (source-checkout
  only). To exercise `openclaw qa`/qa-channel from a built dist, build with
  `OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build` (emits `dist/plugin-sdk/qa-lab.js`,
  `qa-runtime.js`, `dist/extensions/{qa-lab,qa-channel}`) or run via `pnpm dev`.
- With no model flags, character eval uses its current source-defined candidate,
  judge, thinking, and fast defaults.
- Repeat `--model provider/model,thinking=<level>[,fast|,no-fast|,fast=<bool>]`
  or `--judge-model ...` only to replace the corresponding inventory explicitly.
- Do not add new examples with separate `--model-thinking`; keep that flag as legacy compatibility only.
- Report includes judge ranking, run stats, durations, and full transcripts; do not include raw judge replies. Duration is benchmark context, not a grading signal.
- Candidate and judge concurrency default to 16. Use `--concurrency <n>` and `--judge-concurrency <n>` to override when local gateways or provider limits need a gentler lane.
- Scenario source is YAML-only under `qa/scenarios/`: use `index.yaml` and
  per-scenario `*.yaml` files with top-level `title`, `scenario`, and optional
  `flow`. Never add fenced `qa-scenario` / `qa-flow` Markdown files.
- For isolated character/persona evals, write the persona into `SOUL.md` and blank `IDENTITY.md` in the scenario flow. Use `SOUL.md + IDENTITY.md` only when intentionally testing how the normal OpenClaw identity combines with the character.
- Keep prompts natural and task-shaped. The candidate model should receive character setup through `SOUL.md`, then normal user turns such as chat, workspace help, and small file tasks; do not ask "how would you react?" or tell the model it is in an eval.
- Prefer at least one real task, such as creating or editing a tiny workspace artifact, so the transcript captures character under normal tool use instead of pure roleplay.
