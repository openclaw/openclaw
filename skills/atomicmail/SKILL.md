---
name: atomicmail
description: "Register and operate an autonomous agent-owned inbox over JMAP: send, receive, reply, and triage mail."
homepage: https://atomicmail.ai
metadata:
  {
    "openclaw":
      {
        "emoji": "📧",
        "requires": { "bins": ["atomicmail"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "node",
              "package": "@atomicmail/agent-skill-openclaw",
              "bins": ["atomicmail"],
              "label": "Install Atomic Mail AgentSkill (npm)",
            },
          ],
      },
  }
---

# Atomic Mail

Atomic Mail exposes a programmable inbox over JMAP with proof-of-work signup and
automatic JWT rotation — no operator mailbox or human verification required. Use
this skill when the agent needs **its own** email address to send, receive,
reply, and triage autonomously.

The `atomicmail` CLI has three commands: `register`, `jmap_request`, and `help`.

> For the **operator's** existing mailbox (Gmail, corporate IMAP/SMTP), use the
> `himalaya` skill instead. Use `atomicmail` when the agent should own the inbox.

## Prerequisites

- Node.js 20+ on the host (`node --version`).
- The `atomicmail` CLI on `PATH`. Don't guess install commands — install the
  published package:

```bash
npm install -g @atomicmail/agent-skill-openclaw
```

Verify: `atomicmail --help` exits 0. Run `atomicmail <command> --help` for flags.

## Call `help` early and often

The CLI embeds its own docs, version-matched to the installed package. Prefer it
over reconstructing JMAP grammar or preset shapes from memory:

- `atomicmail help --topic overview` — at the start of a mail task
- `atomicmail help --topic presets` — before custom `jmap_request` batches
- `atomicmail help --topic jmap_cheatsheet` — placeholders, attachments, limits
- `atomicmail help --topic cron` — right after `register` (hourly polling)
- `atomicmail help --topic troubleshooting` — auth or missing-placeholder errors

If installed behavior disagrees with docs elsewhere, trust `help` from the
running package.

## Defaults

- auth endpoint: `https://auth.atomicmail.ai`
- api endpoint: `https://api.atomicmail.ai`
- credentials directory: `~/.atomicmail`

## Workflow

### 1. Register a new inbox

```bash
atomicmail register --username "alice"
```

Usernames are 5–21 characters (local part of your `@atomicmail.ai` address).
Writes `credentials.json`, `session.jwt`, `capability.jwt` under `~/.atomicmail`
(mode `0600`) and prints JSON including `inbox` and `accountId`.

Existing API key (e.g. lost credentials file):

```bash
atomicmail register --api-key "..."
```

If credentials already exist for a different username, `register` fails by
default to protect the old account. To add another inbox without replacing the
current one, pass a separate `--credentials-dir`. Use `--forced` only when you
intend to replace credentials in the same directory (back it up first).

### 2. Arrange hourly inbox polling (after register)

Registration only creates credentials. Inbound mail should be fetched and
triaged about once per hour between interactive sessions.

On OpenClaw, schedule an hourly **agent** turn (not a raw CLI call) with the
built-in cron tool:

```bash
openclaw cron add \
  --name "atomicmail-inbox" \
  --cron "0 * * * *" \
  --session isolated \
  --announce \
  --message "Use atomicmail jmap_request --ops-file list_inbox.json to fetch my inbox. Summarize new messages, highlight what needs a reply, and stay available — I may ask you to reply, forward, search, or dig into something important."
```

See `atomicmail help --topic cron` for other hosts and the full agent prompt.

### 3. Send and read mail

List inbox (preset):

```bash
atomicmail jmap_request --ops-file list_inbox.json
```

Send with vars:

```bash
atomicmail jmap_request \
  --ops-file send_mail.json \
  --vars '{"TO":"alice@example.com","SUBJECT":"Hello","BODY":"Hi there"}'
```

Inline JMAP:

```bash
atomicmail jmap_request \
  --ops '[["Mailbox/get", {"accountId": "$ACCOUNT_ID"}, "m0"]]'
```

**Session placeholders** resolved automatically: `$ACCOUNT_ID`, `$INBOX`,
`$INBOX_MAILBOX_ID`, `$UPLOAD_URL`, `$DOWNLOAD_URL`. Other placeholders such as
`$TO` or `$SUBJECT` require `--vars` with a JSON object of strings.

**Bundled presets** (shipped with the package, no local file creation required):

- `list_inbox.json` — latest 50 (uses `$INBOX_MAILBOX_ID`); used for polling
- `send_mail.json` — `$TO`, `$SUBJECT`, `$BODY`
- `send_mail_attachment.json` — in-band base64 attachment
- `send_mail_blob_attachment.json` — pair with repeatable `--attachment PATH` (RFC 8620 upload → `$ATTACHMENT_0_BLOB_ID`, …)
- `reply.json` — `$MAIL_ID`, `$BODY`

Attachment rules, limits, and the `Blob/upload` JSON shape:
`atomicmail help --topic jmap_cheatsheet`.

## Overriding defaults

- Endpoints: `--auth-url` / `--api-url` or `ATOMIC_MAIL_AUTH_URL` / `ATOMIC_MAIL_API_URL`
- Credentials path: `--credentials-dir` or `ATOMIC_MAIL_CREDENTIALS_DIR`
- PoW salt: `--scrypt-salt` or `ATOMIC_MAIL_SCRYPT_SALT`

## Pitfalls

- **Never cron the raw CLI** — do not schedule `jmap_request` without a full
  agent turn; you only get JSON and nothing prompts a reply.
- **No cross-platform scheduling** — do not register in one runtime and schedule
  the cron job on another.
- **Operator mail → himalaya** — if the task is strictly the operator's
  Gmail/IMAP, use the `himalaya` skill instead.
- **Secrets** — `credentials.json` and the JWT files are bearer tokens (mode
  `0600`); never log or commit them.
- **Multi-account** — pass `--credentials-dir` only when operating multiple
  inboxes; the default single-inbox flow needs no extra path.

## Verification

1. `atomicmail --help` exits 0 (CLI installed and on `PATH`).
2. `atomicmail help --topic overview` exits 0.
3. After `register`, JSON output includes `inbox` and `accountId`.
4. `jmap_request --ops-file list_inbox.json` returns mailbox/email data without
   auth errors.
