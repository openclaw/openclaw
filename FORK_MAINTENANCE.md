# Fork Maintenance

`mctl-openclaw` is a fork of [`openclaw/openclaw`](https://github.com/openclaw/openclaw). Treat `openclaw/openclaw` as the canonical upstream and keep this repository as a thin patch layer on top.

## Upstream Sync Workflow

The default maintenance mode is a weekly sync PR from `upstream/main` into this fork's `main`.

1. `upstream` points at `https://github.com/openclaw/openclaw.git`.
2. A scheduled GitHub Actions workflow creates a branch `sync/upstream-YYYY-MM-DD`.
3. That branch merges `upstream/main` into `origin/main`.
4. The workflow opens or updates a PR back to `main`.
5. Merge only after CI and the `labs-openclaw` rollout checks pass.

Use manual syncs only for urgent upstream fixes that cannot wait for the weekly cadence.

## Fork-Specific Patch Areas

Review these areas on every upstream sync PR:

- `mctl` OAuth and gateway behavior
  - Browser connect flow
  - Silent refresh behavior for `mctl.connect.status`
  - Trusted-proxy and Control UI assumptions
- OpenAI Codex integration
  - Auth persistence
  - Localhost/manual callback flow decisions
  - Runtime profile wiring
- `mctl-agent` / webhook automation
  - Hook endpoint behavior
  - Auto-claim / auto-result prompt policy
  - Session creation from inbound hooks
- Whisper/runtime packaging
  - Builder image expectations
  - Cache restore/fallback logic
  - Shared library packaging and model defaults
- Platform-specific deployment assumptions
  - Health endpoints and worker templates
  - MCTL-specific ingress/auth wiring
  - Any path that depends on GitOps rather than upstream defaults

## Release Checklist After a Sync PR

After merging an upstream sync PR:

1. Create a fresh fork tag.
2. Build a new image from that tag.
3. Roll `labs-openclaw` to the new image.
4. Confirm ArgoCD reports `Synced Healthy`.
5. Verify:
   - `mctl` connect and token refresh
   - Codex connect
   - Hook endpoint reachability
   - One basic chat/session flow

Do not promote a sync to other tenants until `labs-openclaw` is healthy.

## What Should Stay Fork-Only

Keep changes fork-only when they depend on:

- MCTL OAuth or control-plane specifics
- Trusted-proxy behavior unique to the platform
- `mctl-agent` webhook contracts
- Tenant/GitOps deployment conventions

Upstream generic fixes whenever the change is broadly useful and does not rely on MCTL-only behavior.
