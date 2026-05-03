# Outlook Setup Guide

Connect the Outlook skill to your Microsoft account.

Most teammates should use the **automated script** (`outlook-setup.sh`) —
it walks you through everything in ~3 minutes if the shared app registration
is already in the team vault. The manual steps below are for understanding
what the script does, or for Option B (your own app registration).

## Prerequisites

- Microsoft account (Outlook.com, Hotmail, Live, or Microsoft 365)
- `jq` and `curl` installed (`sudo apt install jq curl`)
- For Option B only: Azure CLI (`az`) and access to
  [Azure Portal](https://portal.azure.com)

---

## Recommended: run the automated script

```bash
~/Projects/openclaw-team-workspace/main-agent/skills/outlook/scripts/outlook-setup.sh
```

The script will:

1. **Detect existing credentials in `~/.outlook-mcp/config.json`** and
   offer to reuse them (the "fast path"). If you have a working config
   from a prior setup, just say `Y` here and skip to the browser
   authorization step.
2. **Otherwise** prompt you to paste the shared `client_id` / `client_secret`
   from the team vault, or fall through to the full Azure-CLI-driven
   Option B flow (app registration, secret creation, permission setup).
3. **Save the config** to `~/.outlook-mcp/config.json` with the file
   backed up first if it already existed.
4. **Open the browser authorization flow** — paste back the localhost
   callback URL when the browser redirects.
5. **Verify three scopes** with per-scope probes (inbox, mailbox settings,
   people lookup) so failures point at exactly which consent didn't land.
6. **Register cron jobs** for the triage pipeline in the triage agent's
   workspace:
   - `check-and-trigger.sh` every minute
   - `outlook-seen.sh prune` daily at 3 AM

The script is idempotent — safe to re-run. It strips any existing matching
cron lines before re-registering, and backs up `config.json` /
`credentials.json` before overwriting.

If the script worked, you're done. The rest of this guide covers manual
setup for Option B, troubleshooting, and what each step does under the
hood.

---

## Manual: Option A (shared app registration)

The team maintains one Azure AD app registration (`Clawdbot-Outlook`) that
everyone authorizes against with their own mailbox. Tokens are per-user;
the app itself is shared.

- **`CLIENT_ID`:** `071a9762-cc36-4205-a7b6-4787f310c8c8`
- **`CLIENT_SECRET`:** retrieve from the team password vault
  (entry: `Clawdbot-Outlook`)

The `client_id` is not a secret — it's transmitted in plaintext on every
auth request and is safe to commit. The `client_secret` must stay in the
vault.

Skip to [Step 2](#step-2-save-configuration).

---

## Manual: Option B (your own app registration)

Follow this path if:

- Your tenant blocks multi-tenant apps
- You're forking this workspace for a different team
- You need blast-radius isolation from the shared app

### B.1 Register the app

1. Go to https://portal.azure.com
2. Search for **"App registrations"** → click it
3. Click **"+ New registration"**
4. Configure:
   - **Name:** `Clawdbot-Outlook` (or any name)
   - **Supported account types:** _Accounts in any organizational directory
     and personal Microsoft accounts_
   - **Redirect URI:** Platform = Web, URI = `http://localhost`
5. Click **Register**

### B.2 Get client credentials

1. On the app overview page, copy the **Application (client) ID** →
   this is your `CLIENT_ID`
2. Go to **Certificates & secrets** in the left menu
3. Click **+ New client secret**
4. Add a description (e.g., `clawdbot`) and choose expiration (max 24 months)
5. Click **Add**
6. **Immediately copy the Value** (not the ID) → this is your `CLIENT_SECRET`
   - ⚠️ You can only see this once. Save it in your password manager right
     now — if you lose it, you have to generate a new one and every other
     user of the shared app has to rotate theirs too.

### B.3 Configure API permissions

1. Go to **API permissions** in the left menu
2. Click **+ Add a permission**
3. Select **Microsoft Graph** → **Delegated permissions**
4. Add these permissions:
   - `Mail.ReadWrite` — read and write mail
   - `Mail.Send` — send mail
   - `Calendars.ReadWrite` — read and write calendar
   - `MailboxSettings.Read` — read mailbox settings (required for cached
     timezone on token refresh)
   - `User.ReadBasic.All` — look up colleagues by name/email
     (required for people lookup; may need admin consent on work/school
     tenants)
   - `User.Read` — read your own profile
5. Click **Add permissions**

`offline_access` is requested at auth time, not configured here.

---

## Step 2: Save configuration

Create the config directory:

```bash
mkdir -p ~/.outlook-mcp
```

Create `~/.outlook-mcp/config.json`:

```json
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET",
  "timezone": ""
}
```

The `timezone` field is populated automatically on first token refresh from
your mailbox settings. It uses Windows timezone format (e.g.,
`"India Standard Time"`), not IANA (`"Asia/Kolkata"`) — this is what
Microsoft Graph's `Prefer` header expects.

Lock down the file:

```bash
chmod 600 ~/.outlook-mcp/config.json
```

---

## Step 3: Authorize the app

Build the authorization URL (replace `YOUR_CLIENT_ID`):

```
https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&scope=https://graph.microsoft.com/Mail.ReadWrite%20https://graph.microsoft.com/Mail.Send%20https://graph.microsoft.com/Calendars.ReadWrite%20https://graph.microsoft.com/MailboxSettings.Read%20https://graph.microsoft.com/User.ReadBasic.All%20offline_access&response_mode=query
```

1. Open the URL in a browser
2. Sign in with your Microsoft account (MFA may be required, especially
   from a new network location)
3. Grant the requested permissions
4. You'll be redirected to `http://localhost?code=XXXXX...`
   (the browser will show a connection error — expected, the URL bar has
   what you need)
5. Copy the `code` value from the URL (everything after `code=` up to `&`
   or end of URL)

---

## Step 4: Exchange code for tokens

```bash
CLIENT_ID="your-client-id"
CLIENT_SECRET="your-client-secret"
AUTH_CODE="the-code-from-step-3"

curl -s -X POST "https://login.microsoftonline.com/common/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  --data-urlencode "code=$AUTH_CODE" \
  --data-urlencode "redirect_uri=http://localhost" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "scope=https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/MailboxSettings.Read https://graph.microsoft.com/User.ReadBasic.All offline_access" \
  > ~/.outlook-mcp/credentials.json

chmod 600 ~/.outlook-mcp/credentials.json
```

`--data-urlencode` (instead of one concatenated `-d` string) keeps the
`client_secret` off curl's visible command line — other processes on the
system can otherwise read it via `/proc/<pid>/cmdline` while the request
is in flight.

The authorization code is single-use and expires in ~10 minutes. If this
step fails (e.g., invalid secret, network blip), you need to re-do Step 3
to get a fresh code — don't try to reuse the old one.

---

## Step 5: Verify setup

Three checks — each isolates a different scope so failures point at which
consent didn't land.

**Inbox access** (`Mail.ReadWrite`) — must succeed:

```bash
ACCESS_TOKEN=$(jq -r '.access_token' ~/.outlook-mcp/credentials.json)

curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/inbox" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  | jq '{total: .totalItemCount, unread: .unreadItemCount}'
```

**Mailbox settings** (`MailboxSettings.Read`) — required for cached
timezone, soft failure:

```bash
curl -s "https://graph.microsoft.com/v1.0/me/mailboxSettings/timeZone" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq
```

Expected: `{"value": "India Standard Time"}` or similar. A 403 here means
`MailboxSettings.Read` consent didn't land.

**People lookup** (`User.ReadBasic.All`) — soft failure:

```bash
curl -s "https://graph.microsoft.com/v1.0/users?\$top=1&\$select=displayName,mail" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq
```

A 403 here usually means admin consent is required; the agent can still do
everything else — only person-by-name lookups break.

Once the first check passes, trigger a token refresh to populate the cached
timezone in `config.json`:

```bash
./scripts/outlook-token.sh refresh
```

Then confirm `config.json` shows a non-empty `timezone` field.

---

## Step 6: Register cron jobs (triage pipeline)

The triage agent uses cron, not OpenClaw's internal scheduler. Two jobs:

```
* * * * * ~/Projects/openclaw-team-workspace/outlook-traige-agent/skills/outlook/check-and-trigger.sh
0 3 * * * ~/Projects/openclaw-team-workspace/outlook-traige-agent/skills/outlook/outlook-seen.sh prune
```

To install them manually (the script does this automatically in
`setup_cron`):

```bash
TRIAGE_DIR="$HOME/Projects/openclaw-team-workspace/outlook-traige-agent/skills/outlook"

(crontab -l 2>/dev/null | grep -v "check-and-trigger\|outlook-seen.*prune"; \
 echo "* * * * * $TRIAGE_DIR/check-and-trigger.sh"; \
 echo "0 3 * * * $TRIAGE_DIR/outlook-seen.sh prune") | crontab -
```

Verify:

```bash
crontab -l
```

The triage scripts handle their own logging — `check-and-trigger.sh` writes
to `outlook-hook.log` at the triage workspace root. No redirect needed in
the cron line.

---

## Troubleshooting

**`AADSTS700016: Application not found`**
Double-check `client_id`. If using Option A, confirm you copied the full
UUID. If using Option B, ensure you selected _Accounts in any organizational
directory and personal Microsoft accounts_ during registration.

**`AADSTS7000215: Invalid client secret`**
The secret was rotated on the app registration. For Option A, re-pull the
current secret from the team vault. For Option B, check Azure Portal →
app → Certificates & secrets and see if your secret is still listed and
non-expired. If not, create a new one (and notify teammates if it's a
shared app).

**`AADSTS7000218: ... body must contain client_assertion or client_secret`**
The `client_secret` param was empty or missing. Check `~/.outlook-mcp/config.json`
actually has a non-empty `client_secret` field. If the setup script wrote
an empty secret, check its backup files (`config.json.bak.*`) for the
previous value.

**`AADSTS50076: multi-factor authentication required`**
Your tenant's conditional access policy is forcing re-MFA, typically
triggered by a new network location. Run `outlook-setup.sh` (or Step 3
manually) from the new location — the browser will prompt for MFA, and
the refreshed tokens will be bound to the new location.

**`AADSTS65001: User hasn't consented`**
Re-run Step 3. Make sure you click _Accept_ on the consent screen. If
scopes were recently added to the shared app, even already-authorized
users need to re-consent.

**`403 Forbidden` on `/me/mailboxSettings/timeZone`**
`MailboxSettings.Read` was not consented. Re-run the authorize URL — the
browser will re-prompt for the missing scope. Work/school accounts may
require admin consent.

**`403 Forbidden` on `/users`**
`User.ReadBasic.All` was not consented. Usually needs admin consent on
work/school tenants. Contact IT, or skip this scope if you don't need
people lookups.

**Token expired**
Access tokens last ~1 hour. Run `./scripts/outlook-token.sh refresh` to
get a new one. Refresh tokens last ~90 days with rolling renewal — as long
as you use the skill regularly, you won't need to re-authorize.

**Work/school account issues**
Your organization may require admin consent for some scopes (especially
`User.ReadBasic.All`). Contact your IT admin or use a personal Microsoft
account for testing.

**Timezone stuck as empty string in `config.json`**
The token refresh populates it. If it's still empty after running
`outlook-token.sh refresh`, check that `MailboxSettings.Read` passed
verification in Step 5 and that `outlook-token.sh` isn't silently
swallowing a 403.

**I lost my `client_secret` and can't find it in the vault**
Check shell history and session transcripts — if you ever ran
`az ad app credential reset` or pasted the secret into a script, it may
still be in `~/.bash_history` or an OpenClaw session JSONL. If genuinely
lost, generate a new secret in Azure Portal → app → Certificates &
secrets, then update the vault and notify teammates.

**Cron jobs missing after reboot or workspace switch**
Cron entries live in `/var/spool/cron/crontabs/<user>` and survive reboots.
If they're gone, someone ran `crontab -e` and saved an empty buffer
(easy to do with `EDITOR=code` — VS Code returns before you save, so the
empty template gets installed). Re-run `outlook-setup.sh` or the manual
Step 6 block to re-register.
