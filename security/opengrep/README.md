# Compiled OpenGrep super-configs

These two YAML files are the **compiled output** of the GHSA detector-review
pipeline. Each rule corresponds to a specific GitHub Security Advisory for
`openclaw/openclaw` and is grouped into one of two buckets.

| File          | Bucket    | Goal                                                                |
| ------------- | --------- | ------------------------------------------------------------------- |
| `precise.yml` | `precise` | High-coverage rules; each was validated to find the original vuln.  |
| `broad.yml`   | `broad`   | Review-aid rules; intentionally noisier; surface code worth review. |

`compile-manifest.json` is a per-rule provenance map for traceability.

## ⚠️ Do not edit by hand

These files are regenerated from per-advisory rule artifacts under
`.artifacts/ghsa-detector-review-runs/<RUN_ID>/cases/<ghsa>/...`. Hand edits
will be lost the next time `scripts/compile-opengrep-rules.mjs` runs.

## Rule naming and metadata

Every rule's id is rewritten to `ghsa-detector.<ghsa-lower>.<original-id>`.
Every rule's `metadata` block is augmented with:

| Key               | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| `ghsa`            | `GHSA-xxxx-xxxx-xxxx`                                          |
| `advisory-url`    | `https://github.com/openclaw/openclaw/security/advisories/...` |
| `detector-bucket` | `precise` or `broad`                                           |
| `source-run`      | the detector-review run id the rule came from                  |
| `source-rule-id`  | the original rule id the agent emitted                         |

## Recompiling

```bash
# from the openclaw repo root
node scripts/compile-opengrep-rules.mjs \
  --run-dir .artifacts/ghsa-detector-review-runs/<RUN_ID>
```

The script:

1. Walks every `cases/<ghsa>/` under the run dir
2. Reads `opengrep/general-rule.yml` (→ precise) and `opengrep/broad-rule.yml`
   (→ broad) when they exist and parse cleanly
3. Rewrites ids and injects metadata as above
4. Runs `opengrep scan --no-strict` against an empty target to identify any
   rules with `InvalidRuleSchemaError` and drops them so the published
   super-config loads cleanly
5. Writes `precise.yml`, `broad.yml`, and `compile-manifest.json`

Anything skipped (YAML parse error or schema-invalid) is recorded under
`preciseInvalid` / `broadInvalid` in `compile-manifest.json` for follow-up.

## Validating locally

```bash
opengrep validate security/opengrep/precise.yml
opengrep validate security/opengrep/broad.yml
```

A non-zero exit is fine if the only errors are individual rule warnings — what
matters is that opengrep can load the file and report a non-zero rule count.
The compile script already drops fatal-class errors for you.

## Running locally

```bash
opengrep scan --no-strict \
  --config security/opengrep/precise.yml \
  --no-git-ignore \
  src/
```

For SARIF output (matching what CI produces):

```bash
opengrep scan --no-strict \
  --config security/opengrep/precise.yml \
  --sarif-output=precise.sarif \
  --no-git-ignore \
  src/
```

## Why `--no-strict`?

Some agent-generated rules trigger non-fatal opengrep warnings (e.g.
TypeScript pattern parse errors on edge-case rules). `--no-strict` keeps
opengrep's exit code clean so the workflow doesn't fail on rule-level
warnings — actual scan errors still surface in stderr and the SARIF.

## Why `--no-git-ignore`?

Some openclaw paths are excluded by `.gitignore` for build reasons even
though they contain meaningful source code we want scanned. `--no-git-ignore`
keeps opengrep from skipping them.
