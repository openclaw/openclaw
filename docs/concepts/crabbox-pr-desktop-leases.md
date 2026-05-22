---
summary: "Maintainer workflow for creating shared Crabbox Linux and macOS desktop leases from pull requests."
read_when:
  - Creating a shared desktop lease for PR inspection
  - Proving a pull request on Crabbox Linux or macOS
  - Debugging WebVNC handoff comments
title: "Crabbox PR Desktop Leases"
---

`Crabbox PR Desktop Lease` is the maintainer handoff workflow for ad hoc PR
desktop inspection. It can create, report, stop, or reset a shared Crabbox
desktop lease for an open PR, then upsert a status comment with the authenticated
portal URL and useful follow-up commands.

Linux leases can use AWS, Azure, or Hetzner. macOS leases use AWS EC2 Mac
capacity with On-Demand market because EC2 Mac runs on Dedicated Host backed
capacity. Lease TTL is capped below the workflow timeout so the GitHub-hosted
WebVNC bridge can stay alive until the lease expires.

The workflow checks the requested PR head before creating a lease and verifies
the fresh remote checkout resolved to that exact commit before posting the lease
as ready. It also refuses to replace an active stale-head lease unless it can
stop the old lease first.

## Actions Entry Point

The workflow is `.github/workflows/crabbox-pr-desktop-lease.yml`.

Manual dispatch inputs:

- `target_repo`: the repository that owns the PR. Defaults to `openclaw/openclaw`.
- `pr_number`: the pull request number.
- `action`: `lease`, `status`, `stop`, or `reset-vnc`.
- `platform`: `linux` or `mac`.
- `ttl_minutes`: requested lease TTL. The script caps this below the workflow
  timeout.
- `head_sha`: optional expected PR head SHA. Use this for proof runs so a pushed
  update cannot accidentally reuse old code.
- `provider`: `aws`, `azure`, or `hetzner`. macOS requires AWS.

The repository dispatch event name is `clawsweeper_crabbox_pr_lease`. That name
is part of the maintainer automation contract.

## Secrets

The workflow prefers generic Crabbox secrets:

- `CRABBOX_COORDINATOR`
- `CRABBOX_COORDINATOR_TOKEN`
- `CRABBOX_ACCESS_CLIENT_ID`
- `CRABBOX_ACCESS_CLIENT_SECRET`

`OPENCLAW_QA_CRABBOX_COORDINATOR` and `OPENCLAW_QA_CRABBOX_COORDINATOR_TOKEN`
are also accepted for shared QA environments.

## First Run Proof

GitHub only exposes manual dispatch for workflows that already exist on the
default branch. First-run proof for changes to this workflow needs either a
trusted default-branch workflow deployment or an operator machine with Crabbox
coordinator, provider, and mac host configuration. Do not run a branch checkout
of the lease script with shared Crabbox secrets.

For a macOS proof, run:

```bash
gh workflow run crabbox-pr-desktop-lease.yml \
  --repo openclaw/openclaw \
  -f target_repo=openclaw/openclaw \
  -f pr_number=<pr-number> \
  -f action=lease \
  -f platform=mac \
  -f provider=aws \
  -f ttl_minutes=60 \
  -f head_sha=<current-pr-head-sha>
```

Then verify the PR comment contains a usable portal handoff, does not expose a
WebVNC password or URL fragment, and that `status`, `reset-vnc`, and `stop`
update the same lease comment.
