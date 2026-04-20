# Security tooling

This directory holds the GHSA detector-review pipeline that turns each
published security advisory for `openclaw/openclaw` into a reusable OpenGrep
rule, plus the supporting tooling and CI to run the compiled rules.

The pipeline is **harness-agnostic**: any coding-agent CLI (Rovo Dev, Claude
Code, Codex, OpenCode, or anything you can shell out to) can drive it via the
runner script's `--harness` flag.

## Layout

```
security/
├── README.md                              <- this file
├── prompt-suffix-coverage-first.md        <- mandatory prompt addendum for the runner
├── detector-review/
│   ├── detector-review-spec.md            <- agent-agnostic spec; loaded into the per-case prompt
│   ├── references/
│   │   ├── detector-rubric.md
│   │   └── report-template.md
│   └── scripts/
│       └── init_case.py                   <- per-case workspace initializer
└── opengrep/
    ├── README.md                          <- per-bucket details + regen recipe
    ├── precise.yml                        <- compiled super-config: precise rules
    ├── broad.yml                          <- compiled super-config: broad/review-aid rules
    └── compile-manifest.json              <- per-rule provenance back to source advisories
```

The two scripts that drive everything live under `scripts/`:

- `scripts/run-ghsa-detector-review-batch.mjs` — runs your coding harness of
  choice in parallel against every advisory using the detector-review spec.
  Each case produces an opengrep `general-rule.yml` (precise) and
  `broad-rule.yml` (review-aid), plus a coverage-validated report against the
  vulnerable commit's changed files.
- `scripts/compile-opengrep-rules.mjs` — gathers all rule YAMLs from a run
  directory and emits the two super-configs under `security/opengrep/`.

## End-to-end flow

```
                                      +--- per-case prompt suffix ---+
                                      |  prompt-suffix-coverage-first.md|
                                      +-------------------------------+
                                                    |
                                                    v
GitHub Advisory API ─► run-ghsa-detector-review-batch.mjs ─► .artifacts/<run>/
                          (--harness claude|rovodev|codex|opencode|<custom>)
                                                    |             ├── manifest.json
                                                    |             └── cases/<ghsa>/...
                                                    v
                              compile-opengrep-rules.mjs ─► security/opengrep/{precise,broad}.yml
                                                                  + compile-manifest.json
                                                    |
                                                    v
                              .github/workflows/opengrep-{precise,broad}.yml
                                              (manual dispatch; SARIF → Code Scanning)
```

## Supported coding harnesses

The runner ships with built-in adapters for the following non-interactive
agent CLIs:

| `--harness` | Binary it shells out to | Notes                                                                              |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `claude`    | `claude -p`             | Default. Claude Code in single-prompt mode. Uses `--dangerously-skip-permissions`. |
| `rovodev`   | `acli rovodev legacy`   | Uses `--yolo` + `--config-override` for model selection.                           |
| `codex`     | `codex exec`            | Codex CLI in single-prompt mode. Uses `--full-auto`.                               |
| `opencode`  | `opencode run`          | OpenCode CLI in single-prompt mode.                                                |

For anything else, pass `--harness-cmd '<template>'` with shell-style
substitution placeholders. Supported substitutions: `{prompt}`, `{model}`,
`{output_file}`. Example:

```bash
node scripts/run-ghsa-detector-review-batch.mjs \
  --harness-cmd 'mycli --auto --model {model} --out {output_file} {prompt}' \
  ...
```

## Regenerating the rules from scratch

You need:

- A non-interactive coding-harness CLI of your choice on `PATH`
  (`acli` for rovodev, `claude` for Claude Code, `codex` for Codex CLI,
  `opencode` for OpenCode, or your own command).
- [opengrep](https://github.com/opengrep/opengrep) on your `PATH`
  (`curl -fsSL https://raw.githubusercontent.com/opengrep/opengrep/main/install.sh | bash`).
- [`gh`](https://cli.github.com/) authenticated for the initial advisory
  fetch.

From the openclaw repo root:

```bash
# 1. Generate per-advisory artifacts (this takes hours; ~5-15 min per advisory)
node scripts/run-ghsa-detector-review-batch.mjs \
  --state published \
  --concurrency 8 \
  --timeout-ms 5400000 \
  --validate-coverage \
  --retry-no-coverage 2 \
  --prompt-suffix-file security/prompt-suffix-coverage-first.md \
  --harness claude       # or: --harness rovodev / --harness codex / --harness opencode

# 2. Compile super-configs from the produced run dir
node scripts/compile-opengrep-rules.mjs \
  --run-dir .artifacts/ghsa-detector-review-runs/<RUN_ID>
```

Then commit the diff under `security/opengrep/`.

## Running the rules locally

The wrapper script handles paths, exclusions, and output formatting so local
scans match CI exactly.

```bash
scripts/run-opengrep.sh                 # precise rules, human output
scripts/run-opengrep.sh broad           # broad review-aid rules
scripts/run-opengrep.sh precise --json  # write .opengrep-out/precise.json
scripts/run-opengrep.sh precise --sarif # write .opengrep-out/precise.sarif
scripts/run-opengrep.sh precise -- src/agents/   # scan a single dir
```

If you'd rather invoke `opengrep` directly, the equivalent is:

```bash
opengrep scan --no-strict --no-git-ignore \
  --config security/opengrep/precise.yml \
  src/ extensions/ apps/ packages/ scripts/
```

Both forms read `.semgrepignore` at the repo root automatically — that's
the single source of truth for which paths are skipped (test files,
fixtures, mocks, QA-tooling extensions, test-orchestration scripts, …).
Add a glob there if a new test naming convention shows up.

## Running the rules in CI

Two manual-dispatch GitHub Actions workflows ship with this PR:

- **OpenGrep — Precise** (`.github/workflows/opengrep-precise.yml`)
- **OpenGrep — Broad** (`.github/workflows/opengrep-broad.yml`)

Both:

- Run `opengrep scan` against `src/ extensions/ apps/ packages/ scripts/`
- Inherit the same `.semgrepignore` exclusions used by the local wrapper
- Upload the SARIF to GitHub Code Scanning (categories `opengrep-precise` and
  `opengrep-broad` so they don't collide with each other or CodeQL)
- Use `continue-on-error: true` so findings never block the workflow

## Silencing or removing rules

The super-configs are **auto-generated** — don't edit them by hand.

To drop a noisy rule:

1. Delete the offending source rule from
   `.artifacts/ghsa-detector-review-runs/<RUN_ID>/cases/<ghsa>/.tmp/ghsa-detector-review/<ghsa>/opengrep/`
2. Re-run `node scripts/compile-opengrep-rules.mjs --run-dir <run-dir>`
3. Commit the resulting `security/opengrep/*.yml` diff

To narrow a rule's path scope, edit the source rule's `paths.include` /
`paths.exclude` fields in the same artifact location and recompile.

## Tracing a finding back to its advisory

Every compiled rule's `id` is `ghsa-detector.<ghsa-lower>.<original-id>` and
its `metadata` includes `ghsa`, `advisory-url`, `detector-bucket`, and
`source-rule-id`. The full forward map (ghsa → bucket → rule-ids → errors)
lives in `security/opengrep/compile-manifest.json`.
