---
name: sre-incident-triage
description: "Use when a BetterStack alert fires, a Slack monitoring channel posts an incident, pod crashloops, OOMKilled, image pull errors, or any production incident needs evidence-first RCA in Morpho EKS clusters. Covers alert intake, incident workflow, blocked mode, RBAC fallbacks."
metadata: { "openclaw": { "emoji": "🚨" } }
---

# SRE Incident Triage

Companion skill to `morpho-sre`. Load `morpho-sre` first for hard rules, paths, and knowledge surfaces.

## When to Use

- BetterStack alert fires in `#staging-infra-monitoring`, `#public-api-monitoring`, or `#platform-monitoring`
- New post in `#bug-report` — investigate with live evidence (no triage, no routing, no Linear ticket creation)
- Pod crashloop, OOMKilled, image pull error, or any k8s workload failure
- Human escalation in a monitoring channel thread
- Any production incident requiring evidence-first RCA

## Slack BetterStack Alert Intake

Monitored channels: `#staging-infra-monitoring` (dev), `#public-api-monitoring` (prod), `#platform-monitoring` (prod), `#bug-report` (investigate-only).

`#bug-report`: every new root post triggers a full investigation using live evidence. Do NOT triage, route to owners, or create Linear tickets — only investigate and reply with findings.

### Reply Format

Always reply in the incident thread under the alert root post -- never in the channel root.

First four lines (mandatory on every reply, including follow-ups):

```
*Incident:* plain-English summary of what broke
*Customer impact:* confirmed / none confirmed / unknown
*Affected services:* concrete services/components
*Status:* investigating / mitigated / resolved + time window
```

If only internal tooling is degraded: `No confirmed customer impact. Internal observability degraded.`

After the header, include:

- `*Evidence:*` 3-5 concrete facts from k8s/events/logs/metrics/traces
- `*Likely cause:*` top hypothesis (only after one successful live check)
- `*Mitigation:*` reversible fix + rollback
- `*Validate:*` 2-3 checks
- `*Next:*` owner/action

Put unrelated warnings under `*Also watching:*`.

### Formatting Rules

- Slack mrkdwn only: bold = `*text*`, inline code = `` `text` ``
- Never use Markdown `**text**` or heading syntax (`##`, `###`)
- Keep thread reply concise (8-12 lines, no prose wall)
- No routing hints, fingerprint changes, raw step names, signal counts, or confidence percentages in the opening

## Incident Workflow

Reference: `morpho-sre/references/incident-workflow.md` for the full step-by-step.

Summary:

1. Run hard preflight (binaries, PATH, AWS identity, kube context)
2. Load one retrieval surface (`knowledge-index.md` / `runbook-map.md` / dossier)
3. Scope: impact, first seen, affected namespace/workload
4. Build image-to-repo correlation map
5. Find affected image, app, repo, revision
6. Cross-check k8s state + logs + metrics + traces
7. Clone related repo only after live evidence or clear config-driven need
8. Name concrete follow-up PR candidate (repo, path, title, validation)
9. Create or reuse Linear ticket; use ticket `branchName` as PR branch
10. If confidence is high and fix is scoped, create PR via `autofix-pr.sh` and link to Linear
11. Return evidence, hypotheses, confidence, suggested PRs, Linear ticket, PR URL (or blocked reason)

## Blocked Mode Reply Contract

Use when preflight fails, RBAC blocks required access, credentials are missing, or runtime is broken.

Required sections:

- `*Incident:*`
- `*Status:* blocked by access/runtime`
- `*Evidence:* <exact command> -> <exact error>`
- `*Next:*` 1-3 concrete checks

Forbidden in blocked mode before one successful live check:

- `*Likely cause:*`
- `Hypotheses`
- Ranked root-cause lists

## RBAC / Access Fallbacks

If `kubectl exec` is forbidden:

- Stop retrying exec on more pods
- Fall back to: `get`, `describe`, `logs`, events, metrics, traces, repo/chart inspection

If GitHub auth fails:

- Stop retrying clone/fetch loops
- Report exact failing command and continue with local repo/chart evidence if sufficient

## Thread Behavior Rules

- Reply with conclusions only in ALL communications. Never include investigation steps, intermediate reasoning, tool output summaries, or step-by-step analysis in any output surface.
- Never send progress-only replies (`On it`, `Found it`, `Let me verify`, `Checking...`) in any Slack context.
- Buffer investigation and send one consolidated reply with findings.
- If new evidence disproves an earlier theory, state `Disproved theory:` and replace it.
- If a human challenges a claim, re-investigate with fresh live evidence immediately.
- For recurring alerts on the same workload (3+ in 24h), answer as one ongoing RCA, not a fresh transient.
- Never leak tool-call JSON, exec-approval warnings, or command-construction failures into the thread.
- **Content gate:** Before posting, verify the message contains at least one `*Evidence:*` fact or `*Mitigation:*` action. If not, buffer until substantive.

## Self-Referential Incidents

When triaging an alert about the bot's own pod (`openclaw-sre`), note in the Status line: `Self-referential incident -- runtime responsiveness may be degraded during investigation` and prioritize fast, minimal evidence collection.

## Follow-Up and Human Interaction

- Human follow-ups after the first bot reply trigger fresh live checks (not duplicate-alert skip).
- If a thread question is vague, infer likely intent from latest triage output, state assumptions explicitly, propose 2-3 concrete next actions, and ask at most one clarifying question.
- If thread drifts into unrelated design/history questions, redirect to DM or new thread.

## Mandatory First Commands

```bash
command -v kubectl aws jq git gh
echo "$PATH"
aws sts get-caller-identity
if [ -f /var/run/secrets/kubernetes.io/serviceaccount/token ]; then
  kubectl get ns | sed -n '1,20p'
else
  export K8S_CONTEXT="${K8S_CONTEXT:-$(kubectl config current-context)}"
  kubectl --context "$K8S_CONTEXT" get ns | sed -n '1,20p'
fi
```

If `command -v` fails or PATH looks wrong, stop and reply in blocked mode.

## Output Contract

- Summary (4-line header)
- Evidence (commands + concrete output snippets)
- Root-cause hypotheses (ranked + confidence, only after live check)
- Next commands
- PR URL when created (or blocked reason + manual fallback)
