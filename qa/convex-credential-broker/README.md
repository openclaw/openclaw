# QA Convex Credential Broker (v1)

Standalone Convex project for shared `qa-lab` live credentials with lease locking.

This broker exposes:

- `POST /qa-credentials/v1/acquire`
- `POST /qa-credentials/v1/heartbeat`
- `POST /qa-credentials/v1/release`

The implementation matches the contract documented in
`docs/help/testing.md` for `--credential-source convex`.

## Policy baked in

- Pool partitioning: by `kind` only
- Selection: least-recently-leased (round-robin behavior)
- Secrets: separate maintainer/CI secrets (shared fallback supported)
- Outage behavior: callers fail fast
- Lease event retention: 2 days (hourly cleanup cron)
- App-level encryption: not included in v1

## Quick start

1. Create a Convex deployment and authenticate your CLI.
2. From this folder:

```bash
cd qa/convex-credential-broker
npm install
npx convex dev
```

3. Deploy:

```bash
npx convex deploy
```

4. In Convex deployment environment variables, set:

- `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`
- `OPENCLAW_QA_CONVEX_SECRET_CI`

Optional fallback:

- `OPENCLAW_QA_CONVEX_SECRET` (shared secret accepted for either role)

## Seed credentials

Use the Convex dashboard Data page to insert rows into `credential_sets`.

Required fields:

- `kind` (for Telegram v1, use `"telegram"`)
- `status` (`"active"` or `"disabled"`)
- `payload` (opaque JSON object; for Telegram: `{ "groupId": "...", "driverToken": "...", "sutToken": "..." }`)
- `createdAtMs` (number, Unix ms)
- `updatedAtMs` (number, Unix ms)
- `lastLeasedAtMs` (number, use `0` for new rows)

Optional:

- `note`
- `lease` (normally omitted; broker manages this field)

## Local request examples

Replace `<site-url>` with your Convex site URL and `<token>` with a configured secret.

Acquire:

```bash
curl -sS -X POST "<site-url>/qa-credentials/v1/acquire" \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{
    "kind":"telegram",
    "ownerId":"local-dev",
    "actorRole":"maintainer",
    "leaseTtlMs":1200000,
    "heartbeatIntervalMs":30000
  }'
```

Heartbeat:

```bash
curl -sS -X POST "<site-url>/qa-credentials/v1/heartbeat" \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{
    "kind":"telegram",
    "ownerId":"local-dev",
    "actorRole":"maintainer",
    "credentialId":"<credential-id>",
    "leaseToken":"<lease-token>",
    "leaseTtlMs":1200000
  }'
```

Release:

```bash
curl -sS -X POST "<site-url>/qa-credentials/v1/release" \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{
    "kind":"telegram",
    "ownerId":"local-dev",
    "actorRole":"maintainer",
    "credentialId":"<credential-id>",
    "leaseToken":"<lease-token>"
  }'
```
