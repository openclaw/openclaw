---
doc-schema-version: 1
summary: "How taxonomy coverage IDs, scenario YAML, and profiles select what a QA run executes, plus the Multipass suite runner."
read_when:
  - You are choosing which scenarios a run covers
  - You need the Multipass suite lane
title: "Canonical scenario coverage"
---

## Canonical scenario coverage

The root `taxonomy.yaml` defines semantic coverage IDs. Scenario YAML files
under `qa/scenarios/` map each scenario to those IDs and own execution
metadata; `execution.channel` or `execution.channels` declares channel
requirements. Taxonomy profiles select
coverage IDs or whole categories, and the catalog resolves their primary
scenario owners. Transport runners apply channel and provider eligibility to
that result instead of keeping scenario-ID allowlists. The channel driver is
an interchangeable run-level implementation choice.

For `qa suite` and `qa run --qa-profile`, omit `--scenario` to use the default
selection. When supplied, at least one non-empty scenario ID is required;
surrounding whitespace and blank values alongside valid IDs are ignored.

Static `qa coverage` output reports the taxonomy-to-scenario mapping. Actual
proof comes from `qa-evidence.json`, which records the executed scenario,
coverage IDs, channel, driver actually used, and result. Channel and driver are
report dimensions, not additional coverage-ID vocabularies or scenario
eligibility axes.

For a disposable Linux VM lane without bringing Docker into the QA path, run:

```bash
pnpm openclaw qa suite --runner multipass --scenario channel-chat-baseline
```

This boots a fresh Multipass guest, installs dependencies, builds OpenClaw
inside the guest, runs `qa suite`, then copies the normal QA report and
summary back into `.artifacts/qa-e2e/...` on the host. It reuses the same
scenario-selection behavior as `qa suite` on the host.

Host and Multipass suite runs execute multiple selected scenarios in
parallel with isolated gateway workers by default. `qa-channel` defaults to
concurrency 4, capped by the selected scenario count. Use `--concurrency
<count>` to tune the worker count, or `--concurrency 1` for serial execution.
Use `qa run --qa-profile personal-agent --provider-mode mock-openai` for the
personal assistant benchmark, or `--qa-profile observability` for the source
checkout telemetry checks. CI uses the same profile resolver for `smoke-ci`;
none of these selectors maintains a second scenario-ID list.

The command exits non-zero when any scenario fails. Use `--allow-failures`
when you want artifacts without a failing exit code.

Live runs forward the supported QA auth inputs that are practical for the
guest: env-based provider keys, the QA live provider config path, and
`CODEX_HOME` when present. Keep `--output-dir` under the repo root so the
guest can write back through the mounted workspace.
