# Deploy runbook — Contabo VPS

End-to-end setup for the openclaw fork at `https://a.arhan.dev`, with
`memory-supabase` and `inbox-triage` enabled.

Total time: ~30 minutes if the prereqs (DNS, Supabase, Google Cloud) are
already done, ~90 minutes from cold.

---

## 0. Prereqs

- A Contabo VPS reachable on the public internet (any tier with ≥4 GB RAM).
- DNS for `a.arhan.dev` ready to point to the VPS IP.
- A Supabase project (free tier is fine).
- A Google Cloud project with the Gmail API enabled and a Desktop OAuth
  client — see `extensions/inbox-triage/README.md` step "Gmail OAuth".
- A fresh Anthropic API key (the one you pasted in chat: revoke it first).

---

## 1. DNS

Create an A record:

```
a.arhan.dev   A   <CONTABO_IPv4>
```

(Optional AAAA for IPv6.) Wait for propagation (`dig +short a.arhan.dev`
should return your VPS IP).

---

## 2. SSH in and install Docker

```bash
ssh root@<CONTABO_IP>
apt update
apt install -y docker.io docker-compose-plugin git postgresql-client
systemctl enable --now docker
```

---

## 3. Clone the fork

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/ArhanCodes/openclaw.git
cd openclaw
git checkout feat/triage-and-second-brain   # or main, after merge
```

---

## 4. Fill in secrets

```bash
cp deploy/.env.example deploy/.env
nano deploy/.env
```

Required fields (rest can stay default):

- `ANTHROPIC_API_KEY` — your fresh key.
- `OPENAI_API_KEY` — for embeddings.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`.
- `GMAIL_USER`, `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`,
  `GMAIL_OAUTH_REFRESH_TOKEN` (run the helper locally first — see step 5).
- `OPENCLAW_WHATSAPP_SELF_JID` — your number, e.g.
  `447712345678@s.whatsapp.net`.

---

## 5. Generate the Gmail refresh token (one-time, on your laptop)

You don't have to do this on the VPS — Gmail OAuth needs a browser. From
your laptop, with Node 22+ installed:

```bash
git clone https://github.com/ArhanCodes/openclaw.git
cd openclaw
pnpm install
cd extensions/inbox-triage
export GMAIL_OAUTH_CLIENT_ID=...
export GMAIL_OAUTH_CLIENT_SECRET=...
node scripts/gmail-auth.mjs
```

Browser opens → consent → terminal prints `GMAIL_OAUTH_REFRESH_TOKEN`. Paste
that into `deploy/.env` on the VPS.

---

## 6. Apply the Supabase schema

From the VPS (or anywhere with `psql`):

```bash
psql "$SUPABASE_DB_URL" -f extensions/memory-supabase/sql/0001_init.sql
psql "$SUPABASE_DB_URL" -f extensions/memory-supabase/sql/0002_journal.sql
```

You should see `CREATE EXTENSION`, `CREATE TABLE`, `CREATE INDEX`, and
`CREATE FUNCTION` notices. Re-runs are safe (everything is `IF NOT EXISTS`).

---

## 7. Boot the stack

```bash
cd /opt/openclaw/deploy
docker compose up -d --build
docker compose logs -f openclaw
```

First build takes ~5-10 minutes (the openclaw image is sizeable). When you
see `gateway listening on 0.0.0.0:7080` and `caddy: serving HTTPS on :443`,
hit the health endpoint:

```bash
curl -sS https://a.arhan.dev/healthz
# expect: {"ok":true}
```

---

## 8. Pair WhatsApp (one-time)

```bash
docker compose exec openclaw openclaw channels login --channel whatsapp
```

A QR code prints in the terminal. On your phone: WhatsApp → Settings →
Linked Devices → Link a device → scan. The Baileys auth lives in the
`openclaw_wa` volume, so this survives container rebuilds.

---

## 9. Register the cron jobs

```bash
docker compose exec openclaw openclaw cron import /root/.openclaw/cron/jobs.json
docker compose exec openclaw openclaw cron list
# expect: daily-inbox-triage @ 0 7 * * *
#         daily-journal      @ 0 22 * * *
```

---

## 10. Smoke test

Run the triage manually right now, no waiting for 7am:

```bash
docker compose exec openclaw openclaw agent \
  --skill inbox-triage \
  --message "Run inbox_triage_run with lookbackHours=72."
```

Within a few seconds, your WhatsApp should receive the brief. If not:

```bash
docker compose logs --tail=200 openclaw | grep -E "inbox-triage|memory-supabase"
```

Common failures:

- `gmail fetch failed: invalid_grant` → refresh token is wrong / revoked.
  Re-run step 5.
- `channel 'whatsapp' has no send-like method` → WhatsApp not paired yet.
  Re-run step 8.
- `memory-supabase: search failed: function match_memory_items(...) does not exist`
  → schema not applied. Re-run step 6.

---

## 11. Updating

```bash
cd /opt/openclaw
git fetch origin
git checkout feat/triage-and-second-brain && git pull
cd deploy
docker compose up -d --build
```

Volumes (`openclaw_state`, `openclaw_wa`, Caddy data) survive rebuilds, so
your WhatsApp pairing, cron jobs, and TLS certs stay intact.

---

## 12. Rollback

```bash
cd /opt/openclaw && git checkout <previous-sha>
cd deploy && docker compose up -d --build
```

If a deployment is truly broken, `docker compose down` (without `-v`) keeps
your volumes; `down -v` wipes them — don't.
