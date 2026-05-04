---
name: flyctl
description: Deploy, scale, inspect, and manage Fly.io apps via flyctl.
homepage: https://fly.io/docs/flyctl/
metadata:
  {
    "openclaw":
      {
        "emoji": "🎈",
        "requires": { "bins": ["flyctl"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "flyctl",
              "bins": ["flyctl", "fly"],
              "label": "Install flyctl (brew)",
            },
          ],
      },
  }
---

# Fly.io CLI

Use `fly` (or `flyctl`, the same binary) to deploy, scale, inspect, and manage apps on Fly.io.

## When to Use

✅ **USE this skill when:**

- "Deploy the app" or "ship to fly"
- "Tail prod logs" or "show recent errors"
- "What's the app's status?" or "is it healthy?"
- Scaling machines up/down or across regions
- Setting, listing, or unsetting app secrets
- SSH'ing into a running machine for triage
- Rolling back a release

## When NOT to Use

❌ **DON'T use this skill when:**

- Other cloud providers (AWS/GCP/Render/Vercel) → not supported
- Local-only development → no Fly resource involved
- Editing the `fly.toml` schema in detail → consult Fly docs
- Billing, payment, or org-membership management → use the Fly dashboard

## Common Commands

### Status & Inspection

```bash
fly status                 # current app state (machines, regions, version)
fly status --watch         # live status (Ctrl+C to exit)
fly releases               # deployment history
fly machines list          # list machines for the current app
fly apps list              # list apps in the active org
```

### Deploy

```bash
fly deploy                            # deploy from cwd using fly.toml
fly deploy --strategy immediate       # replace all at once, no rolling
fly deploy --image flyio/postgres-flex:15   # deploy a specific image
fly deploy --build-only               # build the image without deploying
```

### Logs

```bash
fly logs                   # follow live logs
fly logs --no-tail         # recent logs, then exit
fly logs -i <machine-id>   # logs from a specific machine
fly logs -r iad            # logs from a specific region
```

### Scale

```bash
fly scale show                    # current size + count
fly scale count 2                 # scale to 2 machines
fly scale count 1 --region ord    # 1 machine in ord
fly scale vm shared-cpu-2x        # change machine size
fly scale memory 2048             # set memory in MB
```

### Secrets

```bash
fly secrets list           # list secret names (values are not shown)
fly secrets set KEY=value  # set a secret (triggers a release)
fly secrets unset KEY      # remove a secret
fly secrets import < .env  # set many at once from stdin
```

### SSH & Console

```bash
fly ssh console                                   # SSH into a random running machine
fly ssh console --machine <id>                    # SSH into a specific machine
fly ssh console -C "tail -50 /app/log/prod.log"   # one-off command
```

### Machines

```bash
fly machine restart <id>              # restart a single machine
fly machine stop <id>
fly machine start <id>
fly machine destroy <id> --force      # permanently delete
```

## Quick Workflows

### Tail recent errors

```bash
fly logs --no-tail | grep -iE "error|exception|panic" | tail -50
```

### Pre-deploy check

```bash
fly status                # confirm a healthy starting state
fly deploy --build-only   # verify the image builds
fly deploy
```

### Quick incident triage

```bash
fly status                # snapshot the current state
fly logs --no-tail        # recent logs without following
```

## Notes

- App context is read from `fly.toml` in the current directory unless `-a <app>` is passed.
- Auth: `fly auth login` opens a browser; tokens live in `~/.fly/config.yml`. Never read or send that file to LLM context.
- `fly` and `flyctl` are the same binary; newer docs use `fly`.
- Multi-org users: `fly orgs list`, then `fly --org <slug>` for one-off scoping.
- Deploys block on health checks unless `--strategy immediate` is set.
