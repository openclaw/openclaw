---
name: email-digest
description: "Hourly email intelligence digest for sales and marketing teams. Fetches recent Gmail messages, detects meeting invites, auto-creates calendar events with reminders, summarizes leads and follow-ups, then delivers to configured channels."
metadata:
  {
    "openclaw":
      {
        "emoji": "📬",
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

# Email Intelligence Digest

Fetches the last hour of Gmail, detects meetings, auto-creates calendar events with
reminders, categorizes leads and follow-ups, and delivers a structured digest to
Slack, WhatsApp, Telegram, and the web dashboard.

## When to run

- Called automatically by the hourly cron job
- On-demand: "give me the email digest" / "summarize my emails" / "check for meetings"

---

## Step 1 — Determine time window

Calculate the Unix timestamp for one hour ago:

```bash
# macOS
SINCE=$(date -v-1H +%s)
# Linux
SINCE=$(date -d '1 hour ago' +%s)

NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SINCE_ISO=$(date -u -r "$SINCE" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$SINCE" +"%Y-%m-%dT%H:%M:%SZ")
```

---

## Step 2 — Fetch recent emails

Use `gog gmail messages search` to get individual emails (not threads):

```bash
gog gmail messages search "in:inbox after:${SINCE}" --max 50 --include-body --json
```

If `--include-body` is unavailable, fetch each message body separately:

```bash
gog gmail get <messageId> --json
```

For each email, collect: `id`, `from`, `subject`, `date`, `body` (first 2000 chars), `attachments` (list attachment filenames).

---

## Step 3 — Detect and process meeting invites

**Before categorizing**, scan every email for meeting signals:

### 3a. Identify meeting emails

Flag an email as a meeting invite if ANY of the following are true:

- Subject contains: "meeting", "call", "interview", "invite", "invitation", "calendar", "scheduled", "appointment", "demo", "sync"
- Body contains a meeting link: `meet.google.com/`, `zoom.us/j/`, `teams.microsoft.com/`, `whereby.com/`, `webex.com/`
- Has `.ics` attachment (calendar file)

### 3b. Extract meeting details

For each flagged email, extract:
| Field | How to find it |
|---|---|
| **Title** | Email subject (strip "Re:", "Fwd:", "Invitation:", etc.) |
| **Start datetime** | Parse from body/ICS — look for "Date:", "When:", "Time:", ISO dates |
| **Duration** | Look for "Duration:", "1 hour", "30 min" — default 1 hour if missing |
| **Attendees** | From/To/CC headers, or "Attendees:" in body |
| **Meeting link** | Extract `meet.google.com/...`, `zoom.us/...`, etc. |
| **Location** | Look for "Location:", room names, or the meeting link |
| **Description** | First 500 chars of body |
| **Calendar ID** | Use "primary" unless user specifies another |

### 3c. Create calendar event

For each meeting found, create a Google Calendar event:

```bash
# Format: ISO 8601 (e.g., 2026-02-27T14:00:00+03:00)
gog calendar create primary \
  --summary "MEETING_TITLE" \
  --from "START_ISO" \
  --to "END_ISO" \
  --description "Attendees: NAME1, NAME2\nLink: MEETING_LINK\n\nOriginal email: SUBJECT"
```

If the event already exists (same title + same day), skip creation and note "already in calendar".

### 3d. Format a meeting reminder message

For each new calendar event created, format this message for delivery:

```
📅 New Meeting Added to Calendar

Title: {TITLE}
When: {DAY}, {DATE} at {TIME} ({TIMEZONE})
Duration: {DURATION}
With: {ATTENDEES}
Link: {MEETING_LINK}

Added by OpenClaw ✓
```

### 3e. Deliver meeting reminders to all channels

Send the meeting reminder immediately (do not wait for the digest) to:

**Slack:**

```json
{
  "action": "sendMessage",
  "to": "channel:SLACK_CHANNEL_ID",
  "content": "<meeting reminder message>"
}
```

**WhatsApp:**

```bash
openclaw message send --channel whatsapp --account ACCOUNT --to +2547XXXXXXXX \
  --body-file - <<'EOF'
<meeting reminder message>
EOF
```

**Telegram:**

```bash
openclaw message send --channel telegram --account ACCOUNT --to @CHAT_OR_NUMBER \
  --body-file - <<'EOF'
<meeting reminder message>
EOF
```

**Dashboard:** Include in the digest JSON (see Step 7).

---

## Step 4 — Categorize remaining emails

Classify every non-meeting email into exactly one category:

| Category              | Criteria                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------- |
| **New Leads**         | First contact from an unknown sender; asks about pricing, demo, partnership, "interested in" |
| **Customer Replies**  | Existing contact replying in an ongoing thread                                               |
| **Follow-ups Needed** | Awaiting your response; deadlines mentioned; "please let me know", "following up"            |
| **Internal**          | From your own domain or known team members                                                   |
| **Noise / Auto**      | Newsletters, marketing emails, automated notifications, receipts                             |

---

## Step 4b — Auto-reply to new inbound emails (if enabled)

If `EMAIL_AUTOREPLY_ENABLED=true`, invoke the `email-autorespond` skill with the emails categorised as **New Leads**, **Customer Replies**, and **Follow-ups Needed** from Step 4.

```
Run the email-autorespond skill for the following email IDs:
  - <id1> from <sender1> — "<subject1>"
  - <id2> from <sender2> — "<subject2>"
  ...
These are new inbound emails that need an acknowledgement reply.
```

**Pass to the skill:**
- `messageId`, `threadId`, `from`, `replyTo`, `subject` for each eligible email

**Skip auto-reply for:**
- ❌ Internal email (same company domain)
- ❌ Noise / Auto / newsletters
- ❌ Threads already replied to this session

Include a one-line status in the digest output:
```
📨 Auto-replies sent: {N} (leads: {N}, customers: {N}, follow-ups: {N})
```

---

## Step 5 — Generate the digest

Format in clean mobile-friendly markdown. One line per email item.

```
📬 Email Digest — {START_TIME} → {END_TIME}
{N} emails · {LEADS} leads · {FOLLOWUPS} follow-ups · {MEETINGS} meetings added

---

📅 MEETINGS ADDED TO CALENDAR ({N})
• {Title} — {Day} {Date} at {Time} with {Attendees}
  Link: {meeting_link}

🔥 NEW LEADS ({N})
• {Name} <{email}> — "{subject}"
  → {1-sentence summary}  |  Suggested reply: {brief action}

💬 CUSTOMER REPLIES ({N})
• {Name} — "{subject}"
  → {what changed / what they said}  |  Action: {next step}

⚡ FOLLOW-UPS NEEDED ({N})
• {Name} — "{subject}" — {deadline if mentioned}
  → {what's needed}

🏢 INTERNAL ({N})
• {brief bullet per email}

🔕 NOISE FILTERED: {N} emails skipped

---
Generated: {ISO timestamp}
```

Omit any section that has zero items. Keep each bullet to one line.

---

## Step 6 — Save the digest to disk

```bash
mkdir -p ~/.openclaw/digests
DIGEST_FILE=~/.openclaw/digests/$(date +%Y%m%dT%H%M%S).json

# Build JSON safely using jq
jq -n \
  --arg timestamp "$NOW_ISO" \
  --arg windowStart "$SINCE_ISO" \
  --arg windowEnd "$NOW_ISO" \
  --arg digest "$DIGEST_TEXT" \
  --argjson counts '{"total":N,"leads":N,"replies":N,"followups":N,"meetings":N,"internal":N,"noise":N}' \
  '{timestamp: $timestamp, windowStart: $windowStart, windowEnd: $windowEnd, counts: $counts, digest: $digest}' \
  > "$DIGEST_FILE"
```

If `jq` is unavailable, use Python:

```bash
python3 -c "import json, sys; print(json.dumps({'timestamp': '$NOW_ISO', 'digest': sys.stdin.read()}))" <<< "$DIGEST_TEXT" > "$DIGEST_FILE"
```

---

## Step 7 — Deliver the digest to all channels

### Slack

```json
{
  "action": "sendMessage",
  "to": "channel:SLACK_CHANNEL_ID",
  "content": "<digest markdown>"
}
```

### WhatsApp

```bash
openclaw message send --channel whatsapp --account ACCOUNT --to +2547XXXXXXXX \
  --body-file - <<'EOF'
<digest markdown>
EOF
```

### Telegram

```bash
openclaw message send --channel telegram --account ACCOUNT --to @CHAT \
  --body-file - <<'EOF'
<digest markdown>
EOF
```

### Web dashboard

Automatically served from `http://localhost:18789/digest` — reads the JSON file saved in Step 6.

---

## Step 8 — Output completion summary

```
✅ Email digest complete
📧 {N} emails processed in the last hour
📅 {N} meetings added to Google Calendar
📤 Delivered to: Slack #channel · WhatsApp +2547XX · Telegram @chat
💾 Saved: ~/.openclaw/digests/{filename}.json
🌐 Dashboard: http://localhost:18789/digest
```

---

## Configuration checklist

Before first run:

- `gog auth list` — confirms Gmail account is authenticated
- `gog calendar list` — confirms calendar access
- Slack channel ID — right-click channel → Copy link (last segment is the ID: `C0123456789`)
- WhatsApp account + target number configured in OpenClaw
- Telegram account + chat/group configured in OpenClaw

## Error handling

- `gog` not found → report error, suggest `brew install steipete/tap/gogcli`
- Zero emails → output "📬 No new emails in the last hour. All clear!"
- Calendar creation fails → log the error, note in digest, continue delivery
- A delivery channel fails → note in output, continue with remaining channels
- Never fail silently — always report what was done and what was skipped

## Ideas to try

- "Show me the email digest for today"
- "Generate digest but skip newsletters"
- "Check for meetings in the last 3 hours"
- "Email digest only from customers (not my team)"
- "Add yesterday's missed meetings to calendar"
