# deploy/

Deployment artefacts for running this fork on a single Contabo VPS at
`https://a.arhan.dev`.

- `docker-compose.yml` — openclaw + Caddy stack.
- `Caddyfile` — TLS-terminating reverse proxy.
- `openclaw.json` — gateway config mounted into the container.
- `cron/jobs.json` — scheduled jobs (morning triage, evening journal).
- `.env.example` — copy to `.env` (gitignored) and fill in secrets.
- `runbook.md` — step-by-step VPS install/upgrade/rollback guide.

Start here: [`runbook.md`](./runbook.md).
