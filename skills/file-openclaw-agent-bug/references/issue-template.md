# OpenClaw Agent Bug Issue Template

## Summary

One sentence describing the user-visible failure.

## Impact

- Severity: blocking / severe degradation / intermittent / minor
- User-visible symptom: slow / no response / weaker reasoning / missing tools / crash / auth failure / plugin failure / other
- Affected subsystem guess: gateway / runner / provider / auth / tools / plugin / UI / memory-context / unknown
- Entrypoint: CLI / desktop UI / Telegram / browser / other
- Started: date and approximate local time
- Last known good version or time:
- First known bad version or time:
- Reproducible: yes / no / unknown
- Minimal reproduction found: yes / no / unknown

## Environment

- OpenClaw version or commit:
- Install method:
- OS and architecture:
- Node and package manager versions:
- Workspace path or type, with private path segments redacted:
- Model/provider/auth profile:
- Transport or gateway mode:
- OpenClaw command availability: all present / some failed / openclaw missing

## Expected Behavior

What should have happened.

## Observed Behavior

What actually happened, including exact messages, latency, hangs, or degraded behavior.

## Reproduction Steps

1. Start from a clean description of the state before the failure.
2. List exact prompts, commands, UI actions, or workflow steps.
3. Include whether the failure survives a retry, a new thread, a new workspace, or disabling suspect plugins, if tested.

## Intake Answers

- Exact prompt, command, or UI action that failed:
- Expected result:
- Observed result:
- Recent changes:
- New thread/workspace retry result:
- Suspect plugin-disabled result:
- Permission granted for diagnostics and public issue search: yes / no

## Config Differences From Baseline

Summarize meaningful differences only. Include provider/model routing, auth profile, gateway settings, sandbox/approval mode, timeout settings, MCP/tool config, memory/context settings, workspace overrides, AGENTS/SKILL overlays, and plugin enablement.

- Baseline used: release defaults / current main defaults / clean profile / unknown
- Baseline evidence:
- Baseline unavailable because:

## Plugins, Skills, and Extensions

- Installed:
- Active:
- Failed validation:
- Recently changed:
- Suspect plugin or hook:
- Reproduction with suspect plugins disabled:

## Logs and Diagnostics

Paste selected reviewed redacted excerpts only. Include the incident window and command outputs that failed. Do not attach the full diagnostics directory, raw secrets, unrelated private conversations, or huge logs.

- Local diagnostics bundle path, redacted or omitted from public issue:
- Sanitization review completed: yes / no
- Public excerpts selected:
- Diagnostics command failures: command, exit code, stderr excerpt, likely meaning
- File index reviewed: yes / no

## Similar Issues Searched

- Exact error queries:
- Symptom queries:
- Plugin/provider/model queries:
- Open matches and result counts:
- Closed/regression matches and result counts:
- Top candidate issues:
- Top rejected candidates and reason:
- Selected related issues:
- Duplicate decision: new issue / comment on existing issue / unclear
- Reason this is not a duplicate, or why the evidence belongs on an existing issue:

## Notes and Hypotheses

Separate observed facts from suspected causes. Include unknowns explicitly.
