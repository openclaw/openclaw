# Security tooling

This directory holds the GHSA detector-review pipeline that turns each
published security advisory for `openclaw/openclaw` into a reusable OpenGrep
rule, plus the supporting tooling to run the compiled precise rules.

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
    ├── README.md                          <- precise rulepack details + regen recipe
    ├── precise.yml                        <- compiled super-config: precise rules
    └── compile-manifest.json              <- per-rule provenance back to source advisories
```

The two scripts that drive everything live under `scripts/`:

- `scripts/run-ghsa-detector-review-batch.mjs` — runs your coding harness of
  choice in parallel against every advisory using the detector-review spec.
  Each case can produce an opengrep `general-rule.yml` candidate plus a
  coverage-validated report against the vulnerable commit's changed files.
- `scripts/compile-opengrep-rules.mjs` — gathers generated precise rule YAMLs
  from a run directory and appends new rule IDs to `security/opengrep/precise.yml`.

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
                              compile-opengrep-rules.mjs ─► security/opengrep/precise.yml
                                                                  + compile-manifest.json
                                                    |
                                                    v
                              .github/workflows/opengrep-precise.yml
                                              (PR/main blocking scan + SARIF → Code Scanning)
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

# 2. Append new precise rules from the produced run dir
node scripts/compile-opengrep-rules.mjs \
  --run-dir .artifacts/ghsa-detector-review-runs/<RUN_ID>
```

Then commit the diff under `security/opengrep/`.

Rule quality contract: precise rules must catch the vulnerable behavior they were
written for, should be silent on the corresponding fixed behavior when a fix
exists, and should keep current findings limited to verified regressions or
variants.

## Running the rules locally

The wrapper script handles paths, exclusions, and output formatting so local
scans match CI exactly.

```bash
scripts/run-opengrep.sh                 # precise rules, human output
scripts/run-opengrep.sh --json          # write .opengrep-out/precise.json
scripts/run-opengrep.sh --sarif         # write .opengrep-out/precise.sarif
scripts/run-opengrep.sh --changed       # scan changed first-party paths
scripts/run-opengrep.sh -- src/agents/  # scan a single dir
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

The **OpenGrep — Precise** workflow (`.github/workflows/opengrep-precise.yml`)
runs on pull requests, pushes to `main`, and manual dispatch.

It:

- Runs `scripts/run-opengrep.sh --changed --sarif --error` on pull requests
  so PR findings stay scoped to changed first-party paths
- Runs `scripts/run-opengrep.sh --sarif --error` on pushes to `main` and manual
  dispatch so the rulepack still gets periodic/full repository coverage
- Inherits the same `.semgrepignore` exclusions used by the local wrapper
- Uploads SARIF to GitHub Code Scanning under category `opengrep-precise`
- Fails on precise findings so the rulepack acts as a regression firewall

## Silencing or removing rules

The precise super-config is **auto-generated** — don't edit it by hand.

To drop a noisy rule:

1. Delete the offending source rule from
   `.artifacts/ghsa-detector-review-runs/<RUN_ID>/cases/<ghsa>/.tmp/ghsa-detector-review/<ghsa>/opengrep/`
2. Re-run `node scripts/compile-opengrep-rules.mjs --run-dir <run-dir>`
3. Commit the resulting `security/opengrep/precise.yml` and `compile-manifest.json` diff

To narrow a rule's path scope, edit the source rule's `paths.include` /
`paths.exclude` fields in the same artifact location and recompile.

## Tracing a finding back to its advisory

Every compiled rule's `id` is `ghsa-detector.<ghsa-lower>.<original-id>` and
its `metadata` includes `ghsa`, `advisory-url`, `detector-bucket`, and
`source-rule-id`. The full forward map (ghsa → precise rule IDs → errors)
lives in `security/opengrep/compile-manifest.json`.
