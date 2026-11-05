---
name: openclaw-qa-testing
description: Run, watch, debug, extend, or explain OpenClaw qa-lab and qa-channel scenarios, artifacts, and live lanes.
---

# OpenClaw QA Testing

Use this skill for `qa-lab` / `qa-channel` work. Repo-local QA only.

## Read first

- `docs/concepts/qa-e2e-automation.md`
- `docs/help/testing.md`
- `docs/channels/qa-channel.md`
- `qa/README.md`
- `qa/scenarios/index.yaml`
- `extensions/qa-lab/src/suite.ts`
- `extensions/qa-lab/src/character-eval.ts`

## Model policy

- Normal live suite runs rely on QA Lab source- and auth-aware defaults.
- Do not pass `--model`, `--alt-model`, or `--fast` by default. Omitted
  `--fast` does not mean fast is disabled; fast behavior is source-owned.
- For scenario-specific runs, the complete `execution.summary` is authoritative
  and overrides generic default guidance, including when it requires other
  flags. Add explicit provider/model pins only when
  `execution.config.requiredProvider` or `requiredModel` requires them.

## Default workflow

1. Read the scenario pack and current suite implementation.
2. Decide lane:
   - mock/dev: `mock-openai`
   - real validation: `live-frontier`
3. For a normal live suite, use:

```bash
pnpm openclaw qa suite \
  --provider-mode live-frontier \
  --output-dir .artifacts/qa-e2e/run-all-live-frontier-<tag>
```

4. Watch outputs:
   - summary: `.artifacts/qa-e2e/run-all-live-frontier-<tag>/qa-suite-summary.json`
   - report: `.artifacts/qa-e2e/run-all-live-frontier-<tag>/qa-suite-report.md`
5. If the user wants to watch the live UI, find the current `openclaw-qa` listen port and report `http://127.0.0.1:<port>`.
6. If a scenario fails, fix the product or harness root cause, then rerun the full lane.

## OTEL smoke

For local QA-lab OpenTelemetry validation, use:

```bash
pnpm qa:otel:smoke
```

This starts a local OTLP/HTTP trace receiver, runs the `otel-trace-smoke`
scenario through qa-channel, decodes the emitted protobuf spans, and verifies
the exported trace names and privacy contract. It does not require Opik,
Langfuse, or external collector credentials.

## QA credentials and 1Password

- Use `op` only inside `tmux` for QA secret lookup in this repo.
- Quick auth check inside tmux:

```bash
op account list
```

- Resolve approved 1Password item and field references for:
  - `OPENCLAW_QA_CONVEX_SITE_URL`
  - `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER` for the maintainer role
  - `OPENCLAW_QA_CONVEX_SECRET_CI` for the CI role
- If a required reference is missing or stale, ask the maintainer/operator for its current item and field reference.
  Do not ask for secret values in chat or copy them into logs or proof artifacts.
- The npm Telegram Docker lane requires Convex credential leasing.
  The lease supplies the Test Server SUT bot, QA-user authorization, and test-group metadata
  defined by [Telegram E2E userbot](../telegram-e2e-userbot/SKILL.md).
  Direct Telegram token variables do not replace the required Convex configuration.
- Load the approved site URL and role-specific secret into the command's environment through the approved secret source.
  The preflight requires the site URL and matching role secret before the Docker run.
- With the maintainer configuration loaded, run:

```bash
OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE=convex \
OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE=maintainer \
OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE=mock-openai \
OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC="openclaw@beta" \
pnpm test:docker:npm-telegram-live
```

- `scripts/e2e/npm-telegram-live-runner.ts` reads `OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE`, not `OPENCLAW_QA_PROVIDER_MODE`.
- For authorized hosted proof, use the existing manual lane when its `qa-live-shared` environment has valid Convex CI configuration.
  A dispatch does not provision credentials or bypass a credential refusal.

```bash
ghx workflow run "NPM Telegram Beta E2E" --repo openclaw/openclaw --ref main \
  -f package_spec=openclaw@YYYY.M.D-beta.N \
  -f package_label=openclaw@YYYY.M.D-beta.N \
  -f provider_mode=mock-openai
```

- Poll the exact run id from the dispatch URL. `gh run view --json artifacts` is not supported; list artifacts with:

```bash
gh api repos/openclaw/openclaw/actions/runs/<run-id>/artifacts
```

## WhatsApp live credentials

Use this when setting up or replacing Convex `kind=whatsapp` credentials.

- Treat WhatsApp QA credentials as operator-owned live accounts, not generated fixtures.
- Use two dedicated WhatsApp-capable test numbers: one driver account and one SUT account. Do not use personal numbers or personal OpenClaw WhatsApp accounts in the shared pool.
- Register and link each account manually with WhatsApp or WhatsApp Business, storing Web auth only in isolated local auth dirs outside the repo.
- For group coverage, create a dedicated test group that includes both QA accounts and store its JID as `groupJid`; otherwise the group mention-gating scenario should be skipped by default and fail when explicitly requested.
- Package the two Baileys auth dirs into base64 `.tgz` payload fields and add a new active Convex credential row. Prefer adding a fresh row and disabling stale/broken rows over overwriting credentials in place.
- Expected payload fields: `driverPhoneE164`, `sutPhoneE164`, `driverAuthArchiveBase64`, `sutAuthArchiveBase64`, and optional `groupJid`.
- Keep credential material out of the repo, logs, PRs, and screenshots. Redact phone numbers unless the operator explicitly asks for local debugging.
- Validate with `pnpm openclaw qa whatsapp --credential-source convex --credential-role maintainer --provider-mode mock-openai` and preserve artifact paths plus redacted pass/fail summaries.
- If WhatsApp expires or invalidates a linked Web session, relink locally, package fresh auth archives, add a new Convex row, then disable the stale row.

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

## Codex CLI model lane

Use model refs shaped like `codex-cli/<codex-model>` whenever QA should exercise Codex as a model backend.

Examples:

```bash
pnpm openclaw qa suite \
  --provider-mode live-frontier \
  --model codex-cli/<codex-model> \
  --alt-model codex-cli/<codex-model> \
  --scenario <scenario-id> \
  --output-dir .artifacts/qa-e2e/codex-<tag>
```

```bash
pnpm openclaw qa manual \
  --model codex-cli/<codex-model> \
  --message "Reply exactly: CODEX_OK"
```

- Treat the concrete Codex model name as user/config input; do not hardcode it in source, docs examples, or scenarios.
- Live QA preserves `CODEX_HOME` so Codex CLI auth/config works while keeping `HOME` and `OPENCLAW_HOME` sandboxed.
- Mock QA should scrub `CODEX_HOME`.
- If Codex returns fallback/auth text every turn, first check `CODEX_HOME`,
  relevant secret-backed auth, and gateway child logs before changing
  scenario assertions.
- For model comparison, include `codex-cli/<codex-model>` as another candidate in `qa character-eval`; the report should label it as an opaque model name.

## Repo facts

- Seed scenarios live in `qa/scenarios/index.yaml` and
  `qa/scenarios/<theme>/*.yaml`.
- Main live runner: `extensions/qa-lab/src/suite.ts`
- QA lab server: `extensions/qa-lab/src/lab-server.ts`
- Child gateway harness: `extensions/qa-lab/src/gateway-child.ts`
- Synthetic channel: `extensions/qa-channel/`

## What “done” looks like

- Full suite green for the requested lane.
- User gets:
  - watch URL if applicable
  - pass/fail counts
  - artifact paths
  - concise note on what was fixed

## Common failure patterns

- Live timeout too short:
  - widen live waits in `extensions/qa-lab/src/suite.ts`
- Discovery cannot find repo files:
  - point prompts at `repo/...` inside seeded workspace
- Subagent proof too brittle:
  - prefer stable final reply evidence over transient child-session listing
- Harness “rebuild” delay:
  - dirty tree can trigger a pre-run build; expect that before ports appear

## When adding scenarios

- Add or update scenario YAML under `qa/scenarios/`; do not add `.md` scenario
  files or fenced YAML blocks.
- Keep kickoff expectations in `qa/scenarios/index.yaml` aligned
- Add executable coverage in `extensions/qa-lab/src/suite.ts`
- Prefer end-to-end assertions over mock-only checks
- Save outputs under `.artifacts/qa-e2e/`
