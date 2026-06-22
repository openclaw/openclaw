# Fork-specific notes

This is a fork of openclaw/openclaw, self-hosted on Railway
(service `openclaw-railway`, reached at `hypertransient-agent.up.railway.app`).

## Update model — STRICTLY ONE-WAY (pull only, never push to upstream)

We pull updates **from** the official openclaw/openclaw repo into this fork.
We NEVER push anything back to openclaw/openclaw.

- `.github/workflows/upstream-sync.yml` only ever `git fetch`es from upstream
  (read-only) and only ever `git push`es to `origin` (this fork).
- It disables the `upstream` remote's push URL, so an accidental
  `git push upstream` fails by design.
- It opens issues on THIS repo only (`--repo "$GITHUB_REPOSITORY"`), never
  upstream.
- Do NOT use GitHub's "Sync fork" button — it merges upstream's default branch
  and clobbers our Railway deployment config. Use the workflow instead.

Updates happen by syncing the fork and letting Railway rebuild — never via the
gateway Control UI. The "update available" log line is expected and harmless.

## How the sync works

Runs Mondays 08:00 UTC, or manually (Actions -> "Upstream sync (Railway-safe)"
-> Run workflow):

1. Fetch upstream release tags (read-only).
2. Merge the newest stable release into a temp `sync/<tag>` branch.
3. Take upstream's Dockerfile as-is, then append the Railway bits via
   `scripts/railway-patch-dockerfile.sh` (idempotent, marker-guarded).
4. Prove it builds with a real `docker build` BEFORE promoting.
5. Only if the build passes, fast-forward `main` and push to origin ->
   Railway rebuilds and deploys.
6. On any failure, open an issue on this repo; `main` and Railway are left
   on the last good version.

## Railway-specific bits (do NOT hand-edit upstream src/**)

All Railway customization lives in deployment config, never in upstream source:

- **railway.toml** — healthcheck (`/healthz`) + restart policy. Startup is owned
  by the entrypoint, so there is no `startCommand`.
- **scripts/railway-entrypoint.sh** — Railway mounts the persistent volume
  ROOT-owned at `/home/node/.openclaw`, but the gateway runs as `node`. The
  entrypoint starts as root, `chown`s the volume to node, then drops to node
  with `HOME=/home/node` and `OPENCLAW_STATE_DIR=/home/node/.openclaw` pinned so
  state lands on the volume (not `/root/.openclaw`).
- **scripts/railway-patch-dockerfile.sh** — appends, at the END of the
  Dockerfile (marker-guarded so it survives upstream restructures): the PaaS
  Control UI config (`dangerouslyAllowHostHeaderOriginFallback` +
  `dangerouslyDisableDeviceAuth`) and the entrypoint wiring (`USER root` + COPY +
  `ENTRYPOINT`). It does NOT strip BuildKit mounts.

## Notes

- Railway auto-assigns `$PORT`; the entrypoint binds `--bind lan --port $PORT`.
- Railway DOES support BuildKit cache + bind mounts. (An earlier note claimed
  otherwise — that was wrong and was what kept breaking the build.)
