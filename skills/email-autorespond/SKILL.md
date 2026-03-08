---
name: email-autorespond
description: "Auto-replies to new inbound emails (leads, customer replies) acknowledging receipt. Sends a polite holding message: 'we have received your email and are reviewing it'. Skips newsletters, internal mail, and automated notifications to avoid reply loops."
metadata:
  {
    "openclaw":
      {
        "emoji": "📨",
        "requires": { "bins": ["gog"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/gogcli",
              "bins": ["gog"],
              "label": "Install gog Google Workspace CLI (brew)",
            },
          ],
      },
  }
---

# Email Auto-Responder

Sends a polite acknowledgement reply to every new inbound email that requires human attention — leads, customer replies, and follow-ups. Skips noise, newsletters, internal mail, and previously auto-replied threads to prevent reply loops.

## When to run

- Called automatically by the `email-digest` skill after Step 4 (categorization), when `EMAIL_AUTOREPLY_ENABLED=true`
- On-demand: "auto-reply to new emails" / "send acknowledgement replies" / "reply to leads"

---

## Step 1 — Check if auto-reply is enabled

```bash
if [[ "${EMAIL_AUTOREPLY_ENABLED:-false}" != "true" ]]; then
  echo "Auto-reply is disabled (EMAIL_AUTOREPLY_ENABLED is not set to true). Skipping."
  exit 0
fi
```

Also verify required variables:
- `EMAIL_AUTOREPLY_FROM` — the Gmail address to send from (must match the authenticated gog account)
- `GOG_ACCOUNT` — the authenticated Gmail account

---

## Step 2 — Build the list of emails to reply to

Accept the email list from the calling skill (email-digest) or fetch independently.

**Eligible categories for auto-reply:**
- ✅ New Leads
- ✅ Customer Replies
- ✅ Follow-ups Needed
- ❌ Internal — skip (would reply to your own team)
- ❌ Noise / Auto — skip (would cause reply loops with mailing lists)

For each eligible email, collect:
- `messageId` — Gmail message ID
- `threadId` — Gmail thread ID
- `from` — sender's email address
- `replyTo` — preferred reply address if present (fallback to `from`)
- `subject` — original subject

---

## Step 3 — Check if already replied in this thread

Before sending, verify we have not already auto-replied to this thread:

```bash
# Check thread for existing outbound auto-replies (look for our signature)
gog gmail messages search "in:sent subject:'Re:' label:auto-replied" --json | \
  grep -q "$THREAD_ID" && echo "Already replied, skipping" && continue
```

Alternatively, maintain a local record file:

```bash
REPLIED_THREADS_FILE="${HOME}/.openclaw/auto-replied-threads.txt"
touch "$REPLIED_THREADS_FILE"

if grep -qF "$THREAD_ID" "$REPLIED_THREADS_FILE"; then
  echo "Thread $THREAD_ID already auto-replied. Skipping."
  continue
fi
```

---

## Step 4 — Compose the auto-reply message

Use this exact template (personalise the first name if extractable from the `from` header):

```
Subject: Re: {ORIGINAL_SUBJECT}

Hi {FIRST_NAME_OR_THERE},

Thank you for reaching out to us!

We have received your email and our team is currently reviewing it. We will get back to you as soon as possible — typically within 24 hours on business days.

If your matter is urgent, please feel free to reply to this email and let us know.

Best regards,
The Team

---
This is an automated acknowledgement. A team member will follow up personally.
```

**Extracting the first name:**
- Parse the display name from the `From:` header (e.g., `"John Doe <john@example.com>"` → `John`)
- If no display name, or it looks like a company name (contains `Inc`, `Ltd`, `LLC`, `Corp`, etc.), use `there` instead

---

## Step 5 — Send the auto-reply via gog

```bash
gog gmail reply "$MESSAGE_ID" \
  --body "$REPLY_BODY" \
  --from "${EMAIL_AUTOREPLY_FROM:-$GOG_ACCOUNT}"
```

If `gog gmail reply` is unavailable, use `gog gmail send`:

```bash
gog gmail send \
  --to "$REPLY_TO_ADDRESS" \
  --subject "Re: $ORIGINAL_SUBJECT" \
  --body "$REPLY_BODY" \
  --from "${EMAIL_AUTOREPLY_FROM:-$GOG_ACCOUNT}" \
  --thread-id "$THREAD_ID"
```

---

## Step 6 — Record the replied thread

```bash
echo "$THREAD_ID" >> "$REPLIED_THREADS_FILE"
```

This prevents duplicate replies on the next hourly run if the conversation has not moved on.

---

## Step 7 — Report results

Output a summary of what was done:

```
📨 Auto-Reply Summary
─────────────────────
✅ Replied to {N} emails:
  • {Name} <{email}> — "{subject}"
  • ...

⏭  Skipped {N} threads (already replied / noise / internal):
  • {email} — {reason}

❌ Failed {N} replies:
  • {email} — {error message}
```

---

## Configuration

| Variable | Required | Description |
|---|---|---|
| `EMAIL_AUTOREPLY_ENABLED` | Yes | Set to `true` to enable auto-replies |
| `EMAIL_AUTOREPLY_FROM` | No | Gmail address to send from (defaults to `GOG_ACCOUNT`) |
| `GOG_ACCOUNT` | Yes | Authenticated Gmail account |

---

## Error handling

- `gog` not found → report error, suggest installing via brew
- Send fails → log the error, continue with remaining emails, report at end
- `from` address is your own account → skip (avoids self-reply loop)
- Sender domain matches `EMAIL_AUTOREPLY_FROM` domain → skip if same domain (internal)
- Never fail silently — always report what was sent and what was skipped

## Ideas to try

- "Auto-reply to all new emails"
- "Send acknowledgement to all leads received today"
- "Reply to the 3 new customer emails with our standard response"
