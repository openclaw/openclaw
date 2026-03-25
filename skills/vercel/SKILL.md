---
name: vercel
description: Read-only Vercel inspection via the Vercel CLI using a vault-backed `VERCEL_TOKEN`. Use when checking auth, teams, deployments, build status, logs, or domains. Do not use for deploys, linking, env writes, or any other mutating Vercel action.
homepage: https://vercel.com/docs/cli
metadata:
  openclaw:
    skillKey: vercel
    primaryEnv: VERCEL_TOKEN
    os:
      - darwin
      - linux
    requires:
      bins:
        - vercel
      env:
        - VERCEL_TOKEN
    install:
      - id: node
        kind: node
        package: vercel@50.37.0
        # Keep aligned with OPENCLAW_VERCEL_CLI_VERSION in Dockerfile and
        # docker/sre-runtime.Dockerfile.
        bins:
          - vercel
        label: Install Vercel CLI (node)
---

# Vercel

Use the Vercel CLI in read-only mode with `VERCEL_TOKEN` injected from OpenClaw config or the host environment.
Use `bash ./skills/vercel/vercel-readonly.sh` for command execution so auth stays ephemeral and the command surface stays read-only.

## Hard Rules

- Read-only.
- Never deploy.
- Never link a project.
- Never add, edit, pull, or remove env vars.
- Never add or remove domains, aliases, projects, or teams.
- Never pass `VERCEL_TOKEN` as `--token`; keep it in env only.
- Put the allowed Vercel command first; pass flags only after the command.

If the user asks for a mutating Vercel action, stop at inspection/evidence and ask before doing anything else.
These guardrails exist to prevent accidental production changes and reduce blast radius if the token is misused.

## OpenClaw Wiring

Preferred wiring:

- `skills.entries.vercel.apiKey`

Use a vault-backed secret ref there when available. OpenClaw maps `apiKey` to the skill's `primaryEnv`, so `skills.entries.vercel.apiKey` becomes `VERCEL_TOKEN` at runtime.
Prefer that path for Vault-backed secrets because it accepts SecretRef objects and keeps the skill on the documented `primaryEnv` wiring.

Example vault-backed wiring:

```json5
{
  skills: {
    entries: {
      vercel: {
        // Replace `vault_vercel` with your configured exec provider name.
        apiKey: { source: "exec", provider: "vault_vercel", id: "value" },
      },
    },
  },
}
```

`skills.entries.vercel.env.VERCEL_TOKEN` is only suitable for a literal string override. It does not accept a SecretRef object.

## Auth Bootstrap

Vercel CLI `50.37.0` can try interactive login before honoring env-backed `VERCEL_TOKEN` when no stored Vercel auth exists.

Use `bash ./skills/vercel/vercel-readonly.sh` instead of raw `vercel` on fresh machines:

- it keeps the token out of CLI flags and out of the operator's real home directory
- it writes an ephemeral temp-home auth file
- it avoids polluting the operator's real Vercel config, cache, or stored credentials
- it creates the cache path the CLI expects
- it allows only read-only commands

## Token Scope

- Create the token from the personal account token page.
- For personal-account reads, use a token scoped to the personal account.
- For team reads, use a token scoped to the target team and pair it with `--scope <team-slug>`.
- Rotate the token in Vault as part of normal secret rotation, then rerun `whoami` and `teams list` to confirm the replacement token and scope.
- If `vercel whoami`, `vercel teams list`, or `vercel ls --scope ...` fails, verify the token can access that account or team before debugging anything else.

## First Checks

```bash
printenv VERCEL_TOKEN >/dev/null && echo "VERCEL_TOKEN=set"
bash ./skills/vercel/vercel-readonly.sh whoami
bash ./skills/vercel/vercel-readonly.sh teams list --format json
git remote get-url origin 2>/dev/null
cat .vercel/project.json 2>/dev/null || cat .vercel/repo.json 2>/dev/null
```

## Safe Commands

### Auth and Teams

```bash
bash ./skills/vercel/vercel-readonly.sh whoami
bash ./skills/vercel/vercel-readonly.sh whoami --scope <team-slug>
bash ./skills/vercel/vercel-readonly.sh teams list --format json
```

### Deployments

```bash
bash ./skills/vercel/vercel-readonly.sh ls --format json --scope <team-slug>
bash ./skills/vercel/vercel-readonly.sh inspect <deployment-url>
bash ./skills/vercel/vercel-readonly.sh logs <deployment-url>
```

Use `vercel inspect` for build status and deployment metadata. Use `vercel logs` only when the user wants runtime/build evidence.

### Domains

```bash
bash ./skills/vercel/vercel-readonly.sh domains ls --scope <team-slug>
```

## Working Agreement

- Prefer `--format json` when follow-up parsing matters.
- Prefer `--scope <team-slug>` when there are multiple teams.
- Keep wrapper calls in documented order: command first, then flags.
- Reuse the linked-project context from `.vercel/project.json` or `.vercel/repo.json` for evidence only; do not mutate those files.
- If auth fails, treat it as a token/scope problem first.
- Keep the pinned Vercel CLI version aligned across `Dockerfile` and `docker/sre-runtime.Dockerfile`, and update the related Dockerfile tests in the same change.
