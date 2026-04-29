# Compiled OpenGrep super-configs

`precise.yml` is OpenClaw's shipped precise OpenGrep rulepack. Each rule is tied
to a source advisory through metadata and is intended to have concrete coverage
of the original vulnerable behavior or a verified variant.

Rule provenance lives in each compiled rule's metadata. `compile-manifest.json`
is written into the source rules directory as an audit/debug artifact, not as a
committed source of truth.

Noisy exploratory rules are intentionally kept out of the tracked repo. Anything
appended to `precise.yml` must be low-noise enough to run as a blocking PR-diff
check and as a manual full-repository audit.

## ⚠️ Do not edit by hand

This file is regenerated from maintainer-produced rule artifacts. Hand edits will
be lost the next time `security/opengrep/compile-rules.mjs` runs.

## Rule naming and metadata

Every rule's id is rewritten to `ghsa-xxxx-xxxx-xxxx.<original-id>`. Every
rule's `metadata` block is augmented with source fields enforced by
`pnpm check:opengrep-rule-metadata`:

| Key               | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| `ghsa`            | `GHSA-xxxx-xxxx-xxxx`                                          |
| `advisory-url`    | `https://github.com/openclaw/openclaw/security/advisories/...` |
| `detector-bucket` | `precise`                                                      |
| `source-rule-id`  | the original generated rule id                                 |
| `source-file`     | the source YAML file used during compilation                   |

## Recompiling

```bash
# from the openclaw repo root
node security/opengrep/compile-rules.mjs \
  --rules-dir <folder-with-source-rule-yaml>
```

The script:

1. Recursively walks every `.yml` / `.yaml` file under `--rules-dir`
2. Reads top-level `rules` arrays from those source files
3. Requires each source rule to provide `metadata.ghsa`
4. Rewrites ids and injects metadata as above
5. Appends only new precise rule ids to the existing `precise.yml` by default; pass `--replace-precise` to rebuild it from just the supplied source folder
6. Runs `opengrep scan --no-strict` against an empty target to identify schema-invalid or parser-invalid rules and drops mapped bad rules so the published super-config loads cleanly
7. Writes `precise.yml` and `<rules-dir>/compile-manifest.json`

Anything skipped (YAML parse error, duplicate generated rule id, or schema/parser-invalid) is recorded under `preciseInvalid` / `preciseDuplicateSkipped` in the run-local `compile-manifest.json` for follow-up.

## Validating locally

```bash
pnpm check:opengrep-rule-metadata
opengrep validate security/opengrep/precise.yml
```

The metadata check must pass before rules are committed. OpenGrep validation must
exit zero. Warnings about unknown fields are acceptable only when OpenGrep still
reports `Configuration is valid` and a non-zero rule count. The compile script
drops mapped schema/parser-invalid rules and fails closed when OpenGrep
validation itself cannot be completed.

## Running locally

```bash
scripts/run-opengrep.sh
```

For SARIF output matching the PR workflow's diff-scoped scan:

```bash
scripts/run-opengrep.sh --changed --sarif
```

For SARIF output matching the manual full-repository workflow:

```bash
scripts/run-opengrep.sh --sarif
```

## Why `--no-strict`?

Some generated rules trigger non-fatal opengrep warnings (for example,
unknown-field warnings on compatibility-only keys). `--no-strict` keeps
opengrep's exit code clean for those warnings. Parser-invalid rules are still
dropped during compilation so the checked-in super-config validates before CI
uses it.

## Why `--no-git-ignore`?

Some OpenClaw paths are excluded by `.gitignore` for build reasons even though
they contain meaningful source code we want scanned. `--no-git-ignore` keeps
opengrep from skipping them.
