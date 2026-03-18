# Incident Workflow

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Step-by-step incident investigation workflow for Morpho SRE. Every incident follows this sequence, from preflight through evidence collection to remediation.

## Workflow Steps

1. **Run hard preflight.**
   Verify binaries and PATH (`command -v kubectl aws jq git gh`), AWS identity, and kube context or in-cluster serviceaccount visibility. If preflight fails, stop and switch to blocked mode.

2. **Load one retrieval surface** (`knowledge-index.md` / `runbook-map.md` / dossier) before deep repo spelunking.

3. **Scope incident:** impact, first seen, affected namespace/workload.

4. **Build image-to-repo correlation map.**

   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh
   ```

5. **Find affected image, app, repo, revision.**

6. **Cross-check k8s state + logs + metrics + traces.**

7. **Clone related repo** and inspect suspect commit/config only after live evidence or clear config-driven need.

8. **If fix path is clear,** name the concrete follow-up PR candidate first: repo, path, title, and validation command.

9. **Create or reuse a Linear follow-up ticket** before opening a PR; use that ticket's `branchName` as the PR branch.

10. **If confidence is high and fix is scoped,** create the fix PR automatically and link it back to Linear.

11. **Return evidence, hypotheses, confidence, suggested PRs, Linear ticket, and PR URL** (or blocked reason).

## Evidence Requirements

Every incident reply must include:

- **Evidence:** summarized facts from live checks (not raw command output)
- **Root-cause hypotheses:** ranked with confidence
- **Validation:** what to verify if the top hypothesis needs confirmation
- **Fix PR:** link to existing fix or PR URL when created (or suggested PR candidate)

## Key Constraints

- No root-cause ranking before one successful live check.
- Access/runtime failures alone are not enough evidence for hypotheses.
- Reply with conclusions only in ALL communications -- never include investigation steps, intermediate reasoning, or tool output summaries in any output surface.
- If new evidence disproves an earlier theory, state `Disproved theory:` and replace it before proposing a new cause or PR.
