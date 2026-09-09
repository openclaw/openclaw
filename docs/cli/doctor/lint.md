---
summary: "Read-only lint findings, check selection, and post-upgrade plugin probes"
title: "Lint and post-upgrade modes"
read_when:
  - You want a read-only health report for CI or deployment preflight
  - You are chaining doctor after a build or upgrade
---

Doctor's read-only postures produce findings without changing config or state.
This page covers lint output, check selection, and post-upgrade probes.

## Lint mode

Bare `openclaw doctor --json` is read-only and non-interactive: no prompts, repairs, or config/state rewrites. It emits the same default findings as lint mode, but exits `0` after a report is produced so output formatting does not change ordinary Doctor's advisory success contract. Read the payload's `ok` and `findings` fields to determine health.

Explicit `openclaw doctor --lint` is the deployment-preflight posture. Add `--json` for machine-readable output without changing lint's threshold-based exit code.

```bash
openclaw doctor --json
openclaw doctor --lint
openclaw doctor --lint --severity-min warning
openclaw doctor --lint --json
openclaw doctor --lint --all
openclaw doctor --lint --allow-exec
openclaw doctor --lint --only core/doctor/gateway-config --json
openclaw doctor --lint --only core/doctor/local-audio-acceleration --severity-min info
openclaw doctor --lint --only memory-core/managed-local-embedding-setup --severity-min error --json
```

The managed local embedding setup check is a scoped, non-mutating pre-cutover gate for existing
semantic indexes. It is opt-in through `--only` or `--all`, so plain `doctor --lint` behavior stays
unchanged. It reports missing llama.cpp setup and the interactive `models auth login` remediation
without claiming full Gateway readiness, starting services, downloading models, or changing
config.

Human output is compact:

```text
doctor --lint: ran 6 check(s), 1 finding(s)
  [warning] core/doctor/gateway-config gateway.mode - gateway.mode is unset; gateway start will be blocked.
    fix: Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.
```

JSON output is the scripting surface:

```json
{
  "ok": false,
  "checksRun": 5,
  "checksSkipped": 0,
  "findings": [
    {
      "checkId": "core/doctor/gateway-config",
      "severity": "warning",
      "message": "gateway.mode is unset; gateway start will be blocked.",
      "path": "gateway.mode",
      "fixHint": "Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`."
    }
  ]
}
```

Explicit lint exit codes:

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| `0`  | No findings at or above the selected severity threshold.      |
| `1`  | At least one finding meets the selected threshold.            |
| `2`  | Command/runtime failure before lint findings can be produced. |

`--severity-min` controls both which findings print and the exit threshold: `openclaw doctor --lint --severity-min error` can print nothing and exit `0` even when lower-severity `info`/`warning` findings exist.

Bare `openclaw doctor --json` exits `0` once it emits a findings payload, including when `ok` is `false`. Argument errors or runtime failures before a payload can be produced remain nonzero.

`--all` controls which checks are selected before severity filtering. The default lint run excludes checks that are deep, historical, or more likely to surface repairable legacy residue; use `--all` for the complete inventory. `--only <id>` is the most precise selector and can run any registered check by id.

`core/doctor/local-audio-acceleration` reports the auto-selected local STT command, separate capable/requested/observed backend evidence, and fallback order without loading a speech model. It emits an informational finding, so include `--severity-min info` to display it.

`core/doctor/skill-workshop-relocation` distinguishes pending legacy collection
backup roots from roots preserved for review. Eligible proposals or backup roots
receive `openclaw doctor --fix` guidance, not a guarantee that every backup will
be retired. Preserved roots require manual review of workspace ownership, backup
manifests, and workspace migration blockers. If both kinds remain, Doctor reports
both next steps. Do not delete preserved backups to clear the warning.

## Check selection

```bash
openclaw doctor --lint --only core/doctor/gateway-config --json
openclaw doctor --lint --skip core/doctor/skills-readiness
```

`--only` and `--skip` accept full check ids and may be repeated. An unregistered `--only` id emits a `core/doctor/lint-selection` error finding; valid selected checks still run. Use `checksRun`/`checksSkipped` in the output to confirm a focused gate selects the checks you expect.

To check model credentials, run `openclaw doctor --lint --only core/doctor/auth-profiles --json`.
This opt-in check inspects shared credentials and each configured agent's local
auth store, including fleets without a default agent. Shared credential problems
are reported once; agent-specific cooldowns remain attributed to their local store.

## Post-upgrade mode

`openclaw doctor --post-upgrade` runs plugin compatibility probes for chaining after a build or upgrade. Findings go to stdout; exit code is 1 if any finding has `level: "error"`. Add `--json` for a machine-readable envelope (`{ probesRun, findings }`), suitable for CI, the community `fork-upgrade` skill, and other post-upgrade smoke tooling. If the installed plugin index is missing or malformed, JSON mode still emits the envelope with a `plugin.index_unavailable` error finding.

The probes also warn with `plugin.version_drift` when an enabled official plugin
in the installed index belongs to a different release cohort than the upgraded
OpenClaw CLI. Follow the reported plugin update command, then restart the
Gateway. Exact npm pins receive an update command only after the registry
confirms that target exists. Independently versioned community plugins and
disabled plugins are excluded; version drift alone does not change the exit code.

Container image startup is the exception to the usual "run doctor after
updating" flow. When `openclaw gateway run` starts on a new OpenClaw version, it
runs safe state and plugin repairs before reporting ready. If repair cannot
finish safely, startup exits and tells you to run the same image once with
`openclaw doctor --fix` against the same mounted state/config before restarting
the container normally.
