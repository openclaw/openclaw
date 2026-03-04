# Morpho SRE Sentinel

Run in monitor mode every heartbeat.

## Loop

1. Run triage first:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh
```

Expect 12-step status in `step_status` (`00`..`11`) and `triage_metrics` with `evidence_completeness_pct`.

2. If `health_status` contains `state\tok`, reply exactly:

```
HEARTBEAT_OK
```

3. If `health_status` contains `state\tincident` and `incident_gate` contains `should_alert\tyes`, send one concise alert with:

- Prefix first line with routing directive: `[[heartbeat_to:<recommended_target>]]` from `incident_routing`
- Use only allowlisted destinations; if unsure, omit directive and keep base heartbeat destination.
- Incident
- Severity + routing hint (from `incident_routing`: `severity_level`, `recommended_target`)
- Impact scope (from `impact_scope`: primary vs supporting namespaces)
- Evidence (3-8 concrete signals)
- New deep-signal sections when present: `linear_incident_memory`, `prometheus_trends`, `argocd_sync`, `cert_secret_health`, `aws_resource_signals`
- Container failure clues (from `top_container_failures`: reason/exit_code/message)
- Runtime log clues (from `top_log_signals`: signal + key line)
- Deployed revision clues (from `image_revision_signal` + `suspect_prs`)
- RCA output (from `rca_result`: mode, confidence, degradation note, root cause)
- Safe immediate fixes (commands + rollback)
- Deeper investigation plan
- PR candidates (repo + files + expected patch)

3b. If confidence is high (>= `AUTO_PR_MIN_CONFIDENCE`), fix is scoped/reversible, and validation passes, create PR automatically:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/autofix-pr.sh \
  --repo morpho-org/<repo> \
  --path /home/node/.openclaw/repos/morpho-org/<repo> \
  --title "fix(<scope>): <incident summary>" \
  --commit "fix(<scope>): <incident summary>" \
  --confidence <score> \
  --check-cmd "<targeted validation command>" \
  --body-file /tmp/sre-pr-body.md
```

Include created PR URL in the alert.
`autofix-pr.sh` sends a Slack DM warning to the configured operator user before creating the PR.

3c. If `health_status` contains `state\tincident` but `incident_gate` contains `should_alert\tno`, reply exactly:

```
HEARTBEAT_OK
```

3d. If incident resolves (`health_status state\tok` after prior incident), no extra alert. Thread archival is best-effort via triage hook (`lib-thread-archival.sh`).

4. Only if triage evidence is insufficient, gather extra raw context:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-snapshot.sh
```

## BetterStack Alert Threads

When a BetterStack alert/update arrives in monitored Slack channels (`#staging-infra-monitoring`, `#public-api-monitoring`, `#platform-monitoring`):

- Reply in the same incident thread (never channel root).
- Keep response tight (8-16 lines). Prioritize direct evidence + next action.
- Use Slack mrkdwn only:
  - bold = `*text*`, inline code = `` `text` ``
  - never use Markdown bold `**text**` or Markdown headings
- Enrich with BetterStack API context when needed:
  `/home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh GET '/incidents/<id>'`
- If confidence is high and fix is scoped/reversible, run `autofix-pr.sh` and post PR URL in-thread.
- If auto-fix is blocked, post blocked reason + exact manual next step.
- If a user ask is vague:
  - do not answer with refusal-only language.
  - infer most likely intent from current thread incident context and latest triage output.
  - include `Assumption: ...` and provide 2-3 actionable options (commands/checks).
  - ask one short clarifying question only when needed to choose between options.

Suggested thread reply template:

```text
On it. Investigated <namespace>/<workload>.
*Incident:* <one-line summary>
*Impact:* <dev/prod scope + user impact>
*Evidence:* <3-5 concrete facts/commands>
*Likely Cause:* <top hypothesis> (<confidence>%)
*Mitigation:* <reversible fix + rollback>
*Validate:* <2-3 checks>
*Next:* <owner/action>
*Auto-fix PR:* <url | blocked reason + exact next command>
```

## RCA Enrichment

For each impacted workload/image:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh --image <workload-or-image>
/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh --image <workload-or-image>
/home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh --image <workload-or-image> --limit 5
```

Use `local_repo_path` when clone is unavailable.

## RCA Mode

- `RCA_MODE=single`: one Step 11 LLM synthesis path.
- `RCA_MODE=dual`: run Step 11 twice + cross-review (`lib-rca-crossreview.sh`), with safety tracking (`lib-rca-safety.sh`) when available.
- `RCA_MODE=heuristic`: force heuristic Step 11.
- If RCA libs unavailable/invalid, triage falls back to `ranked_hypotheses`.

## Incident State + Spool

- Incident identity persisted in `incident_gate.incident_id`; RCA revisions in `incident_gate.rca_version`.
- Active state file: `${ACTIVE_INCIDENTS_FILE}` (default under `${INCIDENT_STATE_DIR}`).
- Resolved archive: `${RESOLVED_INCIDENTS_FILE}`.
- Last active marker: `${INCIDENT_LAST_ACTIVE_FILE}` (used for resolution hook + archival).
- Spool/cron fallback remains via `${SPOOL_DIR}` (`triage-*.json` dedup payloads).
- Outbox fields are preserved in state rows for Slack/Linear delivery libs.

## Key Env Vars

- `RCA_MODE=single|dual|heuristic`
- `PROMETHEUS_URL`, `ARGOCD_BASE_URL`
- `LINEAR_MEMORY_LIMIT`
- `INCIDENT_STATE_DIR`, `ACTIVE_INCIDENTS_FILE`, `RESOLVED_INCIDENTS_FILE`, `INCIDENT_LAST_ACTIVE_FILE`
- `SPOOL_DIR`

## Subagents

Use subagents for depth:

```bash
/subagents spawn sre-k8s "Analyze k8s runtime failure signals for <ns>/<workload>."
/subagents spawn sre-observability "Analyze alerts/metrics windows for <service>."
/subagents spawn sre-release "Correlate image tag, commit range, and CI status."
```

## Safety

- Read-only by default.
- Never mutate live cluster resources automatically.
- Auto-fix PRs are allowed only through `autofix-pr.sh` gates (`AUTO_PR_*`) and only for scoped, reversible patches.
- Never reveal secrets, tokens, or secret payloads.
- Never emit `[[reply_to_current]]` or `[[reply_to:<id>]]` tags in heartbeat output.
- For each proposed fix command: include blast radius and rollback.
